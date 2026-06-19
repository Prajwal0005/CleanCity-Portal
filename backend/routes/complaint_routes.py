from flask import Blueprint, request, jsonify, current_app
import json
from flask_jwt_extended import jwt_required, get_jwt_identity
from datetime import datetime
from db import complaints_collection, users_collection, subscriptions_collection
from bson.objectid import ObjectId
from config import VAPID_PRIVATE_KEY, VAPID_CLAIMS
from emailer import send_email
from werkzeug.utils import secure_filename
import os
import uuid

SLA_HOURS = 72
SECOND_ESCALATION_HOURS = 48
ALLOWED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


def save_uploaded_image(file_storage, prefix):
    if not file_storage or not file_storage.filename:
        return None, "Image file is required"

    filename = secure_filename(file_storage.filename)
    _, ext = os.path.splitext(filename)
    ext = ext.lower()
    if ext not in ALLOWED_IMAGE_EXTENSIONS:
        return None, "Unsupported image type. Please upload JPG, PNG, or WEBP."

    upload_dir = current_app.config.get("UPLOAD_FOLDER")
    if not upload_dir:
        return None, "Upload folder not configured"

    os.makedirs(upload_dir, exist_ok=True)
    stored_name = f"{prefix}_{uuid.uuid4().hex}{ext}"
    file_path = os.path.join(upload_dir, stored_name)
    file_storage.save(file_path)

    return f"/uploads/{stored_name}", None


def send_resolution_notifications(user_id, complaint):
    if not VAPID_PRIVATE_KEY:
        return

    try:
        from pywebpush import webpush, WebPushException
    except Exception:
        return

    subs = list(subscriptions_collection.find({"user_id": user_id}))
    if not subs:
        return

    payload = {
        "title": "Complaint Resolved",
        "body": f"{complaint.get('title', 'Complaint')} is resolved.",
        "url": "/frontend/citizen.html"
    }

    for sub in subs:
        subscription = sub.get("subscription")
        if not subscription:
            continue
        try:
            webpush(
                subscription_info=subscription,
                data=json.dumps(payload),
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims=VAPID_CLAIMS
            )
        except WebPushException:
            subscriptions_collection.delete_one({"_id": sub.get("_id")})


def notify_resolution(complaint):
    citizen_id = complaint.get("citizen_id")
    if not citizen_id:
        return
    user = users_collection.find_one({"_id": ObjectId(citizen_id)})
    email = user.get("email") if user else None
    if not email:
        return
    title = complaint.get("title", "Complaint")
    name = user.get("name") if user else "Citizen"
    subject = "CleanCity Complaint Resolved"
    body = (
        f"Hello {name},\n\n"
        f"Your complaint '{title}' has been resolved.\n\n"
        "Thanks for helping keep the city clean.\n"
        "CleanCity Portal"
    )
    html_body = f"""
    <div style="font-family: Arial, sans-serif; color: #0e2b2b;">
      <div style="background: #e7f6f0; padding: 18px 20px; border-radius: 12px;">
        <h2 style="margin: 0 0 6px;">CleanCity Complaint Resolved</h2>
        <p style="margin: 0;">Hello {name},</p>
      </div>
      <div style="padding: 16px 4px;">
        <p>Your complaint <strong>{title}</strong> has been resolved.</p>
        <p style="margin-top: 12px;">Thanks for helping keep the city clean.</p>
      </div>
      <div style="font-size: 12px; color: #5a6b6b;">CleanCity Portal • Smart Waste Management System</div>
    </div>
    """
    ok, error = send_email(email, subject, body, html_body)
    if not ok:
        current_app.logger.warning("Resolution email failed for %s: %s", email, error)


def notify_admin_escalation(complaint, level):
    admins = list(users_collection.find({"role": "admin", "email": {"$exists": True}}))
    if not admins:
        return

    title = complaint.get("title", "Complaint")
    location = complaint.get("location", "Location not provided")
    citizen = complaint.get("citizen_name", "Citizen")
    subject = f"CleanCity Escalation L{level}: {title}"
    body = (
        f"Complaint escalated to level {level}.\n\n"
        f"Title: {title}\n"
        f"Citizen: {citizen}\n"
        f"Location: {location}\n"
    )
    html_body = f"""
    <div style="font-family: Arial, sans-serif; color: #0e2b2b;">
      <div style="background: #fff3cd; padding: 16px 20px; border-radius: 12px;">
        <h2 style="margin: 0 0 6px;">Escalation Level {level}</h2>
        <p style="margin: 0;">Immediate attention required.</p>
      </div>
      <div style="padding: 14px 4px;">
        <p><strong>Title:</strong> {title}</p>
        <p><strong>Citizen:</strong> {citizen}</p>
        <p><strong>Location:</strong> {location}</p>
      </div>
      <div style="font-size: 12px; color: #5a6b6b;">CleanCity Portal</div>
    </div>
    """

    for admin in admins:
        email = admin.get("email")
        if not email:
            continue
        ok, error = send_email(email, subject, body, html_body)
        if not ok:
            current_app.logger.warning("Escalation email failed for %s: %s", email, error)

complaint_bp = Blueprint('complaint_bp', __name__)

def serialize_complaint(c):
    return {
        "_id": str(c["_id"]),
        "title": c.get("title"),
        "description": c.get("description"),
        "issue_type": c.get("issue_type"),
        "location": c.get("location"),
        "phone": c.get("phone"),
        "status": c.get("status"),
        "priority": c.get("priority"),
        "assigned_to": c.get("assigned_to"),
        "assigned_worker_id": c.get("assigned_worker_id"),
        "assigned_worker_name": c.get("assigned_worker_name"),
        "assigned_at": c.get("assigned_at"),
        "accepted_at": c.get("accepted_at"),
        "started_at": c.get("started_at"),
        "worker_acknowledged": bool(c.get("accepted_at")),
        "work_started": bool(c.get("started_at")),
        "citizen_name": c.get("citizen_name"),
        "image_url": c.get("image_url"),
        "resolved_image_url": c.get("resolved_image_url"),
        "escalated": c.get("escalated", False),
        "escalated_at": c.get("escalated_at"),
        "escalated_by": c.get("escalated_by"),
        "escalated_level": c.get("escalated_level", 0),
        "escalated_level2_at": c.get("escalated_level2_at"),
        "feedback": c.get("feedback"),
        "feedback_rating": c.get("feedback_rating"),
        "feedback_at": c.get("feedback_at"),
        "submitted_at": c.get("submitted_at"),
    }


@complaint_bp.route("/create-complaint", methods=["POST"])
@jwt_required()
def create_complaint():
    user_id = get_jwt_identity()
    user = users_collection.find_one({"_id": ObjectId(user_id)})

    if user["role"] != "citizen":
        return jsonify({"error": "Only citizens can create complaints"}), 403

    data = request.form if request.form else (request.get_json() or {})
    image_url = None
    image_file = request.files.get("image") if request.files else None

    if image_file:
        image_url, error = save_uploaded_image(image_file, "complaint")
        if error:
            return jsonify({"error": error}), 400
    else:
        image_url = data.get("image_url")

    if not image_url:
        return jsonify({"error": "Complaint image is required"}), 400

    complaint = {
        "title": data.get("title"),
        "description": data.get("description"),
        "issue_type": data.get("issue_type"),
        "location": data.get("location"),
        "phone": data.get("phone"),
        "citizen_id": str(user["_id"]),
        "citizen_name": user.get("name"),
        "image_url": image_url,
        "status": "Pending",
        "priority": "Medium",
        "assigned_to": None,
        "assigned_worker_id": None,
        "assigned_worker_name": None,
        "assigned_at": None,
        "accepted_at": None,
        "started_at": None,
        "escalated": False,
        "escalated_at": None,
        "escalated_by": None,
        "escalated_level": 0,
        "escalated_level2_at": None,
        "submitted_at": datetime.now(),
        "status_history": [
            {
                "status": "Pending",
                "timestamp": datetime.now()
            }
        ]
    }

    complaints_collection.insert_one(complaint)

    return jsonify({"message": "Complaint created successfully"}), 201


@complaint_bp.route("/complaints", methods=["GET"])
def get_all_complaints():
    complaints = []

    for c in complaints_collection.find():
        complaints.append(serialize_complaint(c))

    return jsonify(complaints), 200


@complaint_bp.route("/complaints/my", methods=["GET"])
@jwt_required()
def get_my_complaints():
    user_id = get_jwt_identity()
    user = users_collection.find_one({"_id": ObjectId(user_id)})

    if not user or user.get("role") != "citizen":
        return jsonify({"error": "Unauthorized"}), 403

    complaints = []
    for c in complaints_collection.find({"citizen_id": str(user["_id"])}):
        complaints.append(serialize_complaint(c))

    return jsonify(complaints), 200



@complaint_bp.route("/assign-complaint/<complaint_id>", methods=["PUT"])
@jwt_required()
def assign_complaint(complaint_id):
    current_user_id = get_jwt_identity()
    current_user = users_collection.find_one({"_id": ObjectId(current_user_id)})

    if not current_user or current_user.get("role") != "admin":
        return jsonify({"error": "Unauthorized"}), 403

    data = request.get_json() or {}
    worker_id = (data.get("worker_id") or "").strip()

    if not worker_id:
        return jsonify({"error": "worker_id is required"}), 400

    worker = None
    if ObjectId.is_valid(worker_id):
        worker = users_collection.find_one({"_id": ObjectId(worker_id), "role": "worker"})
    if not worker:
        worker = users_collection.find_one({"name": worker_id, "role": "worker"})

    if not worker:
        return jsonify({"error": "Worker not found"}), 404

    worker_name = worker.get("name") or "Worker"

    result = complaints_collection.update_one(
        {"_id": ObjectId(complaint_id)},
        {
            "$set": {
                "assigned_to": worker_name,
                "assigned_worker_id": str(worker["_id"]),
                "assigned_worker_name": worker_name,
                "assigned_at": datetime.now(),
                "accepted_at": None,
                "started_at": None,
                "status": "Assigned"
            },
            "$push": {
                "status_history": {
                    "status": "Assigned",
                    "timestamp": datetime.now()
                }
            }
        }
    )

    if result.matched_count == 0:
        return jsonify({"error": "Complaint not found"}), 404

    return jsonify({"message": "Complaint assigned successfully"}), 200


@complaint_bp.route("/admin/complaint/status/<complaint_id>", methods=["PUT"])
@jwt_required()
def update_complaint_status(complaint_id):
    current_user_id = get_jwt_identity()
    current_user = users_collection.find_one({"_id": ObjectId(current_user_id)})

    if not current_user or current_user.get("role") != "admin":
        return jsonify({"error": "Unauthorized"}), 403

    data = request.get_json()
    new_status = data.get("status")

    if new_status not in ["Pending", "Assigned", "Accepted", "Work Started", "Awaiting Verification", "Resolved"]:
        return jsonify({"error": "Invalid status value"}), 400

    complaint = complaints_collection.find_one({"_id": ObjectId(complaint_id)})
    if not complaint:
        return jsonify({"error": "Complaint not found"}), 404

    if new_status == "Resolved" and not complaint.get("resolved_image_url"):
        return jsonify({"error": "Resolution image required before resolving"}), 400

    result = complaints_collection.update_one(
        {"_id": ObjectId(complaint_id)},
        {
            "$set": {"status": new_status},
            "$push": {
                "status_history": {
                    "status": new_status,
                    "timestamp": datetime.now()
                }
            }
        }
    )

    if new_status == "Resolved":
        citizen_id = complaint.get("citizen_id")
        if citizen_id:
            send_resolution_notifications(citizen_id, complaint)
        notify_resolution(complaint)

    return jsonify({"message": "Status updated successfully"}), 200


@complaint_bp.route("/worker/complaint/<complaint_id>", methods=["PUT"])
@jwt_required()
def resolve_complaint(complaint_id):
    current_user_id = get_jwt_identity()
    current_user = users_collection.find_one({"_id": ObjectId(current_user_id)})

    if not current_user or current_user.get("role") != "worker":
        return jsonify({"error": "Unauthorized"}), 403

    data = request.form if request.form else (request.get_json() or {})
    worker_id = (data.get("worker_id") or "").strip()
    image_url = None
    image_file = request.files.get("image") if request.files else None

    if image_file:
        image_url, error = save_uploaded_image(image_file, "resolution")
        if error:
            return jsonify({"error": error}), 400
    else:
        image_url = data.get("image_url")

    if not image_url:
        return jsonify({"error": "Resolution image is required"}), 400

    worker = None
    if worker_id and ObjectId.is_valid(worker_id):
        worker = users_collection.find_one({"_id": ObjectId(worker_id), "role": "worker"})
    if not worker and worker_id:
        worker = users_collection.find_one({"name": worker_id, "role": "worker"})

    worker_name = worker.get("name") if worker else worker_id
    worker_object_id = str(worker["_id"]) if worker else None

    complaint_filter = {"_id": ObjectId(complaint_id)}
    if worker_object_id:
        complaint_filter["$or"] = [
            {"assigned_worker_id": worker_object_id},
            {"assigned_to": worker_name},
        ]
    elif worker_name:
        complaint_filter["assigned_to"] = worker_name

    result = complaints_collection.update_one(
        complaint_filter,
        {
            "$set": {
                "status": "Awaiting Verification",
                "resolved_image_url": image_url
            },
            "$push": {
                "status_history": {
                    "status": "Awaiting Verification",
                    "timestamp": datetime.now()
                }
            }
        }
    )

    if result.matched_count == 0:
        return jsonify({"error": "Complaint not found or not assigned"}), 404

    complaint = complaints_collection.find_one({"_id": ObjectId(complaint_id)})
    return jsonify({"message": "Resolution submitted for verification"}), 200



@complaint_bp.route("/admin/complaint/history/<complaint_id>", methods=["GET"])
def get_complaint_history(complaint_id):
    complaint = complaints_collection.find_one(
        {"_id": ObjectId(complaint_id)},
        {"status_history": 1}
    )

    if not complaint:
        return jsonify({"error": "Complaint not found"}), 404

    return jsonify(complaint.get("status_history", [])), 200



@complaint_bp.route("/admin/complaint/priority/<complaint_id>", methods=["PUT"])
def set_priority(complaint_id):
    data = request.get_json()
    priority = data.get("priority")

    if priority not in ["High", "Medium", "Low"]:
        return jsonify({"error": "Invalid priority"}), 400

    result = complaints_collection.update_one(
        {"_id": ObjectId(complaint_id)},
        {"$set": {"priority": priority}}
    )

    if result.matched_count == 0:
        return jsonify({"error": "Complaint not found"}), 404

    return jsonify({"message": "Priority updated"}), 200


@complaint_bp.route("/admin/escalations/digest", methods=["POST"])
@jwt_required()
def send_escalation_digest():
    user_id = get_jwt_identity()
    admin = users_collection.find_one({"_id": ObjectId(user_id)})

    if not admin or admin.get("role") != "admin":
        return jsonify({"error": "Unauthorized"}), 403

    admins = list(users_collection.find({"role": "admin", "email": {"$exists": True}}))
    if not admins:
        return jsonify({"error": "No admin emails configured"}), 400

    escalated = list(
        complaints_collection.find({"escalated": True, "status": {"$ne": "Resolved"}})
    )
    if not escalated:
        return jsonify({"message": "No active escalations"}), 200

    lines = []
    rows = []
    for c in escalated:
        title = c.get("title", "Complaint")
        citizen = c.get("citizen_name", "Citizen")
        location = c.get("location", "Location not provided")
        level = c.get("escalated_level", 1)
        lines.append(f"L{level} - {title} | {citizen} | {location}")
        rows.append(
            f"<tr><td>L{level}</td><td>{title}</td><td>{citizen}</td><td>{location}</td></tr>"
        )

    subject = "CleanCity Escalation Digest"
    body = "Active escalations:\n" + "\n".join(lines)
    html_body = f"""
    <div style="font-family: Arial, sans-serif; color: #0e2b2b;">
      <h2>CleanCity Escalation Digest</h2>
      <p>Active escalations pending action:</p>
      <table style="width: 100%; border-collapse: collapse;">
        <thead>
          <tr style="text-align: left; background: #f2f6f9;">
            <th style="padding: 8px; border: 1px solid #e5e7eb;">Level</th>
            <th style="padding: 8px; border: 1px solid #e5e7eb;">Title</th>
            <th style="padding: 8px; border: 1px solid #e5e7eb;">Citizen</th>
            <th style="padding: 8px; border: 1px solid #e5e7eb;">Location</th>
          </tr>
        </thead>
        <tbody>
          {''.join(rows)}
        </tbody>
      </table>
    </div>
    """

    errors = []
    for admin_user in admins:
        email = admin_user.get("email")
        if not email:
            continue
        ok, error = send_email(email, subject, body, html_body)
        if not ok:
            errors.append(f"{email}: {error}")

    if errors:
        return jsonify({"error": " | ".join(errors)}), 500

    return jsonify({"message": "Escalation digest sent"}), 200


@complaint_bp.route("/complaints/<complaint_id>/escalate", methods=["POST"])
@jwt_required()
def escalate_complaint(complaint_id):
    user_id = get_jwt_identity()
    user = users_collection.find_one({"_id": ObjectId(user_id)})

    if not user or user.get("role") != "citizen":
        return jsonify({"error": "Only citizens can escalate complaints"}), 403

    complaint = complaints_collection.find_one({"_id": ObjectId(complaint_id)})
    if not complaint:
        return jsonify({"error": "Complaint not found"}), 404

    if complaint.get("citizen_id") != str(user["_id"]):
        return jsonify({"error": "Unauthorized"}), 403

    if complaint.get("status") == "Resolved":
        return jsonify({"error": "Resolved complaints cannot be escalated"}), 400

    submitted_at = complaint.get("submitted_at")
    if submitted_at:
        diff_hours = (datetime.now() - submitted_at).total_seconds() / 3600
        if diff_hours < SLA_HOURS:
            return jsonify({"error": "SLA not breached yet"}), 400

    level = complaint.get("escalated_level", 0)
    if level == 0 and complaint.get("escalated"):
        level = 1

    if level >= 2:
        return jsonify({"message": "Complaint already escalated to level 2"}), 200

    if level == 1:
        escalated_at = complaint.get("escalated_at")
        if not escalated_at:
            escalated_at = datetime.now()
        diff_hours = (datetime.now() - escalated_at).total_seconds() / 3600
        if diff_hours < SECOND_ESCALATION_HOURS:
            return jsonify({"error": "Second escalation not available yet"}), 400

        complaints_collection.update_one(
            {"_id": ObjectId(complaint_id)},
            {
                "$set": {
                    "escalated_level": 2,
                    "escalated_level2_at": datetime.now()
                },
                "$push": {
                    "status_history": {
                        "status": "Escalated Level 2",
                        "timestamp": datetime.now()
                    }
                }
            }
        )

        notify_admin_escalation(complaint, 2)
        return jsonify({"message": "Complaint escalated to level 2"}), 200

    complaints_collection.update_one(
        {"_id": ObjectId(complaint_id)},
        {
            "$set": {
                "escalated": True,
                "escalated_at": datetime.now(),
                "escalated_by": str(user["_id"]),
                "escalated_level": 1
            },
            "$push": {
                "status_history": {
                    "status": "Escalated",
                    "timestamp": datetime.now()
                }
            }
        }
    )

    notify_admin_escalation(complaint, 1)
    return jsonify({"message": "Complaint escalated"}), 200


@complaint_bp.route("/complaints/<complaint_id>/feedback", methods=["POST"])
@jwt_required()
def submit_feedback(complaint_id):
    user_id = get_jwt_identity()
    user = users_collection.find_one({"_id": ObjectId(user_id)})

    if not user or user.get("role") != "citizen":
        return jsonify({"error": "Only citizens can submit feedback"}), 403

    complaint = complaints_collection.find_one({"_id": ObjectId(complaint_id)})
    if not complaint:
        return jsonify({"error": "Complaint not found"}), 404

    if complaint.get("citizen_id") != str(user["_id"]):
        return jsonify({"error": "Unauthorized"}), 403

    if complaint.get("status") != "Resolved":
        return jsonify({"error": "Feedback allowed only after resolution"}), 400

    if complaint.get("feedback_rating") is not None:
        return jsonify({"message": "Feedback already submitted"}), 200

    data = request.get_json() or {}
    rating = data.get("rating")
    comment = (data.get("comment") or "").strip()

    try:
        rating_value = int(rating)
    except Exception:
        return jsonify({"error": "Rating must be a number"}), 400

    if rating_value < 1 or rating_value > 5:
        return jsonify({"error": "Rating must be between 1 and 5"}), 400

    complaints_collection.update_one(
        {"_id": ObjectId(complaint_id)},
        {
            "$set": {
                "feedback_rating": rating_value,
                "feedback": comment,
                "feedback_at": datetime.now()
            }
        }
    )

    return jsonify({"message": "Thank you for your feedback!"}), 200


@complaint_bp.route("/admin/dashboard", methods=["GET"])
@jwt_required()
def dashboard():
    user_id = get_jwt_identity()

    user = users_collection.find_one({"_id": ObjectId(user_id)})

    if user["role"] != "admin":
        return jsonify({"error": "Unauthorized"}), 403

    total = complaints_collection.count_documents({})
    pending = complaints_collection.count_documents({"status": "Pending"})
    resolved = complaints_collection.count_documents({"status": "Resolved"})

    return jsonify({
        "total_complaints": total,
        "pending_complaints": pending,
        "resolved_complaints": resolved
    }), 200

@complaint_bp.route("/worker/dashboard", methods=["GET"])
@jwt_required()
def worker_dashboard():
    user_id = get_jwt_identity()

    user = users_collection.find_one({"_id": ObjectId(user_id)})

    if user["role"] != "worker":
        return jsonify({"error": "Unauthorized"}), 403

    complaints = list(
        complaints_collection.find(
            {
                "$or": [
                    {"assigned_worker_id": str(user["_id"])},
                    {"assigned_to": user["name"]},
                ]
            }
        )
    )

    complaints = [serialize_complaint(complaint) for complaint in complaints]
        
    return jsonify({
        "assigned_complaints": complaints
    }), 200

@complaint_bp.route("/admin/assign/<complaint_id>", methods=["PUT"])
@jwt_required()
def assign_complaint_admin(complaint_id):
    current_user_id = get_jwt_identity()
    current_user = users_collection.find_one({"_id": ObjectId(current_user_id)})

    if not current_user or current_user.get("role") != "admin":
        return jsonify({"error": "Unauthorized"}), 403
    
    data = request.get_json() or {}
    worker_id = (data.get("worker_id") or "").strip()

    if not worker_id:
        return jsonify({"error": "worker_id is required"}), 400

    worker = None
    if ObjectId.is_valid(worker_id):
        worker = users_collection.find_one({"_id": ObjectId(worker_id), "role": "worker"})
    if not worker:
        worker = users_collection.find_one({"name": worker_id, "role": "worker"})

    if not worker:
        return jsonify({"error": "Worker not found"}), 404

    result = complaints_collection.update_one(
        {"_id": ObjectId(complaint_id)},
        {
            "$set": {
                "assigned_to": worker.get("name"),
                "assigned_worker_id": str(worker["_id"]),
                "assigned_worker_name": worker.get("name"),
                "assigned_at": datetime.now(),
                "accepted_at": None,
                "started_at": None,
                "status": "Assigned",
            },
            "$push": {
                "status_history": {
                    "status": "Assigned",
                    "timestamp": datetime.now()
                }
            }
        }
    )

    if result.matched_count == 0:
        return jsonify({"error": "Complaint not found"}), 404

    return jsonify({"message": "Complaint assigned successfully"}), 200


@complaint_bp.route("/worker/complaint/<complaint_id>/accept", methods=["PUT"])
@jwt_required()
def accept_worker_complaint(complaint_id):
    current_user_id = get_jwt_identity()
    current_user = users_collection.find_one({"_id": ObjectId(current_user_id)})

    if not current_user or current_user.get("role") != "worker":
        return jsonify({"error": "Unauthorized"}), 403

    worker_name = current_user.get("name") or ""
    complaint_filter = {
        "_id": ObjectId(complaint_id),
        "$or": [
            {"assigned_worker_id": str(current_user["_id"])},
            {"assigned_to": worker_name},
        ],
    }

    complaint = complaints_collection.find_one(complaint_filter)
    if not complaint:
        return jsonify({"error": "Complaint not found or not assigned"}), 404

    if complaint.get("accepted_at"):
        return jsonify({"message": "Job already accepted"}), 200

    complaints_collection.update_one(
        {"_id": ObjectId(complaint_id)},
        {
            "$set": {
                "accepted_at": datetime.now(),
                "status": "Accepted",
            },
            "$push": {
                "status_history": {
                    "status": "Accepted by Worker",
                    "timestamp": datetime.now()
                }
            }
        }
    )

    return jsonify({"message": "Job accepted successfully"}), 200


@complaint_bp.route("/worker/complaint/<complaint_id>/start", methods=["PUT"])
@jwt_required()
def start_worker_complaint(complaint_id):
    current_user_id = get_jwt_identity()
    current_user = users_collection.find_one({"_id": ObjectId(current_user_id)})

    if not current_user or current_user.get("role") != "worker":
        return jsonify({"error": "Unauthorized"}), 403

    worker_name = current_user.get("name") or ""
    complaint_filter = {
        "_id": ObjectId(complaint_id),
        "$or": [
            {"assigned_worker_id": str(current_user["_id"])},
            {"assigned_to": worker_name},
        ],
    }

    complaint = complaints_collection.find_one(complaint_filter)
    if not complaint:
        return jsonify({"error": "Complaint not found or not assigned"}), 404

    if not complaint.get("accepted_at"):
        return jsonify({"error": "Please accept the job first"}), 400

    if complaint.get("started_at"):
        return jsonify({"message": "Work already started"}), 200

    complaints_collection.update_one(
        {"_id": ObjectId(complaint_id)},
        {
            "$set": {
                "started_at": datetime.now(),
                "status": "Work Started",
            },
            "$push": {
                "status_history": {
                    "status": "Work Started",
                    "timestamp": datetime.now()
                }
            }
        }
    )

    return jsonify({"message": "Work marked as started"}), 200
