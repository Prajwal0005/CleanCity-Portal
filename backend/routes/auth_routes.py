from flask import Blueprint, request, jsonify, current_app
from db import users_collection, subscriptions_collection
import bcrypt
import re
import random
from datetime import datetime, timedelta
import secrets
import hashlib
from flask_jwt_extended import create_access_token
from flask_jwt_extended import jwt_required, get_jwt_identity
from bson.objectid import ObjectId
from config import VAPID_PUBLIC_KEY, FRONTEND_BASE_URL
from emailer import send_email

auth_bp = Blueprint('auth_bp', __name__)

EMAIL_REGEX = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
OTP_EXPIRY_MINUTES = 10
RESET_TOKEN_EXPIRY_MINUTES = 30

def is_valid_email(email):
    return bool(email and EMAIL_REGEX.match(email))

def generate_otp():
    return f"{random.randint(100000, 999999)}"

def hash_reset_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()

def resolve_frontend_base(data):
    base = (data or {}).get("frontend_base") or FRONTEND_BASE_URL or ""
    base = base.strip()
    if base:
        return base.rstrip("/")
    return ""

#register

@auth_bp.route("/register", methods=["POST"])
def register():
    data = request.get_json()

    name = data.get("name")
    email = data.get("email")
    password = data.get("password")

    if not name or not email or not password:
        return jsonify({"error": "All fields required"}), 400
    if not is_valid_email(email):
        return jsonify({"error": "Enter a valid email address"}), 400

    existing = users_collection.find_one({"email": email})
    if existing and existing.get("verified", True):
        return jsonify({"error": "Email already exists"}), 400

    hashed_pw = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())
    otp = generate_otp()
    otp_hash = bcrypt.hashpw(otp.encode("utf-8"), bcrypt.gensalt())
    otp_expires = datetime.now() + timedelta(minutes=OTP_EXPIRY_MINUTES)

    if existing:
        users_collection.update_one(
            {"_id": existing["_id"]},
            {
                "$set": {
                    "name": name,
                    "email": email,
                    "password": hashed_pw,
                    "role": "citizen",
                    "verified": False,
                    "otp_hash": otp_hash,
                    "otp_expires": otp_expires
                }
            }
        )
    else:
        users_collection.insert_one({
            "name": name,
            "email": email,
            "password": hashed_pw,
            "role": "citizen",
            "verified": False,
            "otp_hash": otp_hash,
            "otp_expires": otp_expires
        })

    ok, error = send_email(
        email,
        "CleanCity OTP Verification",
        f"Your CleanCity OTP is {otp}. It is valid for {OTP_EXPIRY_MINUTES} minutes.",
        f"""
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #0e2b2b;">
          <h2 style="margin: 0 0 12px;">CleanCity OTP Verification</h2>
          <p>Hello {name},</p>
          <p>Your verification code is:</p>
          <div style="font-size: 24px; font-weight: bold; letter-spacing: 4px; margin: 12px 0;">
            {otp}
          </div>
          <p>This code is valid for {OTP_EXPIRY_MINUTES} minutes.</p>
          <p>Thanks for joining CleanCity Portal.</p>
        </div>
        """
    )
    if not ok:
        current_app.logger.warning("OTP email failed for %s: %s", email, error)
        return jsonify({"error": f"Unable to send OTP email: {error}"}), 500

    return jsonify({"message": "OTP sent to your email. Please verify to complete registration."}), 200


@auth_bp.route("/register/verify", methods=["POST"])
def verify_registration():
    data = request.get_json()
    email = data.get("email")
    otp = data.get("otp")

    if not email or not otp:
        return jsonify({"error": "Email and OTP are required"}), 400

    user = users_collection.find_one({"email": email})
    if not user:
        return jsonify({"error": "User not found"}), 404

    if user.get("verified", False):
        return jsonify({"message": "Email already verified"}), 200

    otp_expires = user.get("otp_expires")
    if otp_expires and datetime.now() > otp_expires:
        return jsonify({"error": "OTP expired. Please request a new OTP."}), 400

    otp_hash = user.get("otp_hash")
    if not otp_hash or not bcrypt.checkpw(otp.encode("utf-8"), otp_hash):
        return jsonify({"error": "Invalid OTP"}), 400

    users_collection.update_one(
        {"_id": user["_id"]},
        {
            "$set": {"verified": True},
            "$unset": {"otp_hash": "", "otp_expires": ""}
        }
    )

    return jsonify({"message": "Email verified successfully. You can now login."}), 200

#login

@auth_bp.route("/login", methods=["POST"])
def login():
    data = request.get_json()

    email = data.get("email")
    password = data.get("password")

    user = users_collection.find_one({"email": email})

    if not user:
        return jsonify({"error": "Invalid email"}), 401

    if not bcrypt.checkpw(password.encode("utf-8"), user["password"]):
        return jsonify({"error": "Invalid password"}), 401
    if user.get("role") == "citizen" and not user.get("verified", True):
        return jsonify({"error": "Email not verified. Please verify your OTP."}), 403

    access_token = create_access_token(
        identity=str(user["_id"])
    )

    return jsonify({
        "message": "Login successful",
        "access_token": access_token,
        "user_id": str(user["_id"]),
        "role": user.get("role"),
        "name": user.get("name")
    }), 200

@auth_bp.route("/forgot-password", methods=["POST"])
def forgot_password():
    data = request.get_json() or {}
    email = (data.get("email") or "").strip()

    if not is_valid_email(email):
        return jsonify({"error": "Enter a valid email address"}), 400

    user = users_collection.find_one({"email": {"$regex": f"^{re.escape(email)}$", "$options": "i"}})
    reset_token = None

    if user:
        reset_token = secrets.token_urlsafe(32)
        reset_token_hash = hash_reset_token(reset_token)
        reset_expires = datetime.now() + timedelta(minutes=RESET_TOKEN_EXPIRY_MINUTES)

        users_collection.update_one(
            {"_id": user["_id"]},
            {"$set": {"reset_token_hash": reset_token_hash, "reset_token_expires": reset_expires}}
        )

        frontend_base = resolve_frontend_base(data)
        if not frontend_base:
            frontend_base = f"{request.host_url.rstrip('/')}/frontend"
        elif frontend_base == request.host_url.rstrip("/"):
            frontend_base = f"{frontend_base}/frontend"

        reset_link = f"{frontend_base}/reset.html?token={reset_token}"

        ok, error = send_email(
            user["email"],
            "CleanCity Password Reset",
            f"Reset your password using this link (valid for {RESET_TOKEN_EXPIRY_MINUTES} minutes): {reset_link}",
            f"""
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #0e2b2b;">
              <h2 style="margin: 0 0 12px;">Reset your CleanCity password</h2>
              <p>We received a request to reset your password.</p>
              <p>
                <a href="{reset_link}" style="display: inline-block; padding: 10px 18px; background: #2f8f3a; color: #ffffff; text-decoration: none; border-radius: 8px;">
                  Reset Password
                </a>
              </p>
              <p>This link expires in {RESET_TOKEN_EXPIRY_MINUTES} minutes.</p>
              <p>If you did not request this, you can ignore this email.</p>
            </div>
            """
        )
        if not ok:
            current_app.logger.warning("Password reset email failed for %s: %s", email, error)
            return jsonify({"error": f"Unable to send reset email: {error}"}), 500

    return jsonify({"message": "If this email is registered, a reset link will be shared shortly."}), 200


@auth_bp.route("/reset-password", methods=["POST"])
def reset_password():
    data = request.get_json() or {}
    token = (data.get("token") or "").strip()
    new_password = (data.get("password") or data.get("new_password") or "").strip()

    if not token or not new_password:
        return jsonify({"error": "Token and new password are required"}), 400
    if len(new_password) < 8:
        return jsonify({"error": "Password should be at least 8 characters"}), 400

    token_hash = hash_reset_token(token)
    user = users_collection.find_one({
        "reset_token_hash": token_hash,
        "reset_token_expires": {"$gt": datetime.now()}
    })

    if not user:
        return jsonify({"error": "Invalid or expired reset link"}), 400

    hashed_pw = bcrypt.hashpw(new_password.encode("utf-8"), bcrypt.gensalt())
    users_collection.update_one(
        {"_id": user["_id"]},
        {"$set": {"password": hashed_pw}, "$unset": {"reset_token_hash": "", "reset_token_expires": ""}}
    )

    return jsonify({"message": "Password reset successfully"}), 200

@auth_bp.route("/admin/create-worker", methods=["POST"])
@jwt_required()
def create_worker():
    current_user_id = get_jwt_identity()
    admin = users_collection.find_one({"_id": ObjectId(current_user_id)})

    if not admin or admin.get("role") != "admin":
        return jsonify({"error": "Unauthorized"}), 403

    data = request.get_json()
    name = data.get("name")
    email = data.get("email")
    password = data.get("password")

    if users_collection.find_one({"email": email}):
        return jsonify({"error": "Email already exists"}), 400

    hashed_pw = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())

    users_collection.insert_one({
        "name": name,
        "email": email,
        "password": hashed_pw,
        "role": "worker",
        "verified": True
    })

    return jsonify({"message": "Worker created successfully"}), 201


@auth_bp.route("/admin/create-user", methods=["POST"])
@jwt_required()
def create_user():
    current_user_id = get_jwt_identity()
    admin = users_collection.find_one({"_id": ObjectId(current_user_id)})

    if not admin or admin.get("role") != "admin":
        return jsonify({"error": "Unauthorized"}), 403

    data = request.get_json() or {}
    name = data.get("name")
    email = data.get("email")
    password = data.get("password")
    role = (data.get("role") or "worker").strip().lower()

    if role not in ["worker", "admin"]:
        return jsonify({"error": "Role must be worker or admin"}), 400

    if not name or not email or not password:
        return jsonify({"error": "All fields required"}), 400

    if users_collection.find_one({"email": email}):
        return jsonify({"error": "Email already exists"}), 400

    hashed_pw = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())

    users_collection.insert_one({
        "name": name,
        "email": email,
        "password": hashed_pw,
        "role": role,
        "verified": True
    })

    label = "Admin" if role == "admin" else "Worker"
    return jsonify({"message": f"{label} created successfully"}), 201


@auth_bp.route("/admin/workers", methods=["GET"])
@jwt_required()
def list_workers():
    current_user_id = get_jwt_identity()
    admin = users_collection.find_one({"_id": ObjectId(current_user_id)})

    if not admin or admin.get("role") != "admin":
        return jsonify({"error": "Unauthorized"}), 403

    workers = []
    for user in users_collection.find({"role": "worker"}).sort("name", 1):
        workers.append(
            {
                "_id": str(user["_id"]),
                "name": user.get("name", ""),
                "email": user.get("email", ""),
                "role": user.get("role", "worker"),
            }
        )

    return jsonify(workers), 200


@auth_bp.route("/admin/reset-password", methods=["POST"])
@jwt_required()
def admin_reset_password():
    current_user_id = get_jwt_identity()
    admin = users_collection.find_one({"_id": ObjectId(current_user_id)})

    if not admin or admin.get("role") != "admin":
        return jsonify({"error": "Unauthorized"}), 403

    data = request.get_json()
    email = data.get("email")
    new_password = data.get("new_password")

    if not email or not new_password:
        return jsonify({"error": "Email and new_password are required"}), 400

    user = users_collection.find_one({"email": email})
    if not user:
        return jsonify({"error": "User not found"}), 404

    hashed_pw = bcrypt.hashpw(new_password.encode("utf-8"), bcrypt.gensalt())
    users_collection.update_one(
        {"_id": user["_id"]},
        {"$set": {"password": hashed_pw}}
    )

    return jsonify({"message": "Password reset successfully"}), 200


@auth_bp.route("/notifications/vapid-public-key", methods=["GET"])
def vapid_public_key():
    if not VAPID_PUBLIC_KEY:
        return jsonify({"error": "VAPID public key not configured"}), 500
    return jsonify({"publicKey": VAPID_PUBLIC_KEY}), 200


@auth_bp.route("/notifications/subscribe", methods=["POST"])
@jwt_required()
def subscribe_notifications():
    user_id = get_jwt_identity()
    data = request.get_json()

    if not data or not data.get("endpoint"):
        return jsonify({"error": "Invalid subscription"}), 400

    subscriptions_collection.update_one(
        {"user_id": user_id, "endpoint": data.get("endpoint")},
        {"$set": {"subscription": data}},
        upsert=True
    )

    return jsonify({"message": "Subscribed"}), 200


@auth_bp.route("/admin/test-email", methods=["POST"])
@jwt_required()
def test_email():
    user_id = get_jwt_identity()
    admin = users_collection.find_one({"_id": ObjectId(user_id)})

    if not admin or admin.get("role") != "admin":
        return jsonify({"error": "Unauthorized"}), 403

    data = request.get_json() or {}
    to_email = data.get("email") or admin.get("email")
    if not to_email:
        return jsonify({"error": "Email required"}), 400

    ok, error = send_email(
        to_email,
        "CleanCity Test Email",
        "This is a test email from CleanCity Portal.",
        """
        <div style="font-family: Arial, sans-serif; color: #0e2b2b;">
          <h2>CleanCity Test Email</h2>
          <p>If you received this, your email setup is working.</p>
        </div>
        """
    )
    if not ok:
        current_app.logger.warning("Test email failed for %s: %s", to_email, error)
        return jsonify({"error": f"Email failed: {error}"}), 500

    return jsonify({"message": "Test email sent"}), 200
