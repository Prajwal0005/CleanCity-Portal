import os

_DOTENV_LOADED = False
try:
    from dotenv import load_dotenv

    load_dotenv()
    _DOTENV_LOADED = True
except Exception:
    pass

if not _DOTENV_LOADED:
    try:
        base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
        env_path = os.path.join(base_dir, ".env")
        if os.path.exists(env_path):
            with open(env_path, "r", encoding="utf-8") as env_file:
                for line in env_file:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, value = line.split("=", 1)
                    if key and key not in os.environ:
                        os.environ[key] = value.strip().strip("\"").strip("'")
    except Exception:
        pass

MONGO_URI = "mongodb+srv://cleancityadmin:Clean1234@cleancity-cluster.wmrcluh.mongodb.net/cleancity?retryWrites=true&w=majority&serverSelectionTimeoutMS=5000"
JWT_SECRET_KEY = "CleanCityPortalSuperSecureSecretKey2026"
JWT_ACCESS_TOKEN_EXPIRES = False
VAPID_PUBLIC_KEY = ""
VAPID_PRIVATE_KEY = ""
VAPID_CLAIMS = {"sub": "mailto:admin@cleancity.gov"}
FRONTEND_BASE_URL = os.getenv("FRONTEND_BASE_URL", "")

# Email notification configuration (SMTP)
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM = os.getenv("SMTP_FROM", SMTP_USER or "cleancity-notify@example.com")
SMTP_USE_TLS = os.getenv("SMTP_USE_TLS", "true").lower() in {"1", "true", "yes"}

# Legacy SMS configuration (unused)
MSG91_AUTH_KEY = ""
MSG91_SENDER_ID = ""
MSG91_TEMPLATE_ID = ""
MSG91_FLOW_ID = ""
MSG91_ROUTE = ""
MSG91_COUNTRY_CODE = ""
