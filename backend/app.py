import os
import logging
from logging.handlers import RotatingFileHandler
from flask import Flask, send_from_directory, request, jsonify
from werkzeug.exceptions import HTTPException
from flask_jwt_extended import JWTManager
from flask_cors import CORS
from routes.complaint_routes import complaint_bp
from routes.auth_routes import auth_bp
from config import JWT_SECRET_KEY, JWT_ACCESS_TOKEN_EXPIRES


app = Flask(__name__)
CORS(app)

FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend"))
UPLOAD_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "uploads"))
LOG_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "logs"))
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(LOG_DIR, exist_ok=True)
app.config["JWT_SECRET_KEY"] = JWT_SECRET_KEY
app.config["JWT_ACCESS_TOKEN_EXPIRES"] = JWT_ACCESS_TOKEN_EXPIRES
app.config["UPLOAD_FOLDER"] = UPLOAD_DIR
jwt = JWTManager(app)
    
def configure_logging(flask_app):
    log_path = os.path.join(LOG_DIR, "cleancity.log")
    handler = RotatingFileHandler(log_path, maxBytes=2_000_000, backupCount=5)
    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s [%(name)s] %(message)s"
    )
    handler.setFormatter(formatter)
    handler.setLevel(logging.INFO)

    flask_app.logger.setLevel(logging.INFO)
    if not any(isinstance(h, RotatingFileHandler) for h in flask_app.logger.handlers):
        flask_app.logger.addHandler(handler)

configure_logging(app)

app.register_blueprint(complaint_bp)
app.register_blueprint(auth_bp)

@app.route('/')
def home():
    return {"message": "Backend running"}

@app.route('/app')
def frontend_app():
    return send_from_directory(FRONTEND_DIR, "index.html")

@app.route('/frontend/<path:filename>')
def frontend_static(filename):
    return send_from_directory(FRONTEND_DIR, filename)

@app.route('/uploads/<path:filename>')
def uploaded_files(filename):
    return send_from_directory(UPLOAD_DIR, filename)

@app.after_request
def log_http_errors(response):
    if response.status_code >= 500:
        app.logger.error("HTTP %s %s -> %s", request.method, request.path, response.status_code)
    elif response.status_code >= 400:
        app.logger.warning("HTTP %s %s -> %s", request.method, request.path, response.status_code)
    return response

@app.errorhandler(Exception)
def handle_unexpected_error(error):
    if isinstance(error, HTTPException):
        return error
    app.logger.exception("Unhandled exception: %s", error)
    return jsonify({"error": "Internal server error"}), 500

if __name__ == '__main__':
    app.run(debug=True)

