import json
import urllib.request
from config import (
    MSG91_AUTH_KEY,
    MSG91_SENDER_ID,
    MSG91_TEMPLATE_ID,
    MSG91_FLOW_ID,
    MSG91_ROUTE,
    MSG91_COUNTRY_CODE,
)


def normalize_phone(number):
    if not number:
        return None
    clean = "".join(ch for ch in str(number) if ch.isdigit())
    if len(clean) >= 10:
        return clean[-10:]
    return None


def send_sms(to_number, message):
    if not (MSG91_AUTH_KEY and MSG91_SENDER_ID):
        return False, "MSG91 credentials missing"

    to_number = normalize_phone(to_number)
    if not to_number:
        return False, "Invalid phone number"

    try:
        if MSG91_FLOW_ID:
            return _send_via_flow(to_number, message)
        return _send_via_route(to_number, message)
    except Exception:
        return False, "MSG91 request failed"


def _send_via_flow(to_number, message):
    url = "https://control.msg91.com/api/v5/flow/"
    payload = {
        "flow_id": MSG91_FLOW_ID,
        "sender": MSG91_SENDER_ID,
        "mobiles": f"{MSG91_COUNTRY_CODE}{to_number}",
        "message": message,
    }
    return _post_json(url, payload)


def _send_via_route(to_number, message):
    url = "https://control.msg91.com/api/v2/sendsms"
    payload = {
        "sender": MSG91_SENDER_ID,
        "route": MSG91_ROUTE,
        "country": MSG91_COUNTRY_CODE,
        "sms": [
            {
                "message": message,
                "to": [to_number],
                "template_id": MSG91_TEMPLATE_ID or None,
            }
        ],
    }
    return _post_json(url, payload)


def _post_json(url, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("authkey", MSG91_AUTH_KEY)

    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            status = response.getcode()
            if 200 <= status < 300:
                return True, None
            return False, f"MSG91 HTTP {status}"
    except Exception as exc:
        return False, str(exc)
