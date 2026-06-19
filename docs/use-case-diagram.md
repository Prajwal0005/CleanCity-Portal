# CleanCity Portal Use Case Diagram

This document contains Mermaid.js code for the CleanCity Portal use case diagram.
Actors are placed outside the system boundary, and all portal use cases are shown inside the box.

## Mermaid.js Diagram

```mermaid
flowchart LR
    citizen["Citizen"]
    admin["Admin"]
    worker["Worker"]
    email["Email Service"]
    push["Push Notification Service"]

    subgraph system["CleanCity Portal System"]
        direction TB

        uc_register(["Register Account"])
        uc_verify_otp(["Verify Email OTP"])
        uc_login(["Login"])
        uc_forgot(["Request Password Reset"])
        uc_reset(["Reset Password"])
        uc_subscribe(["Subscribe to Notifications"])

        uc_create_complaint(["Create Complaint"])
        uc_upload_photo(["Upload Complaint Image"])
        uc_view_my(["View My Complaints"])
        uc_view_detail(["View Complaint Details"])
        uc_track_status(["Track Complaint Status"])
        uc_escalate(["Escalate Complaint"])
        uc_feedback(["Submit Feedback"])

        uc_admin_dashboard(["View Admin Dashboard"])
        uc_view_all(["View All Complaints"])
        uc_filter_search(["Search and Filter Complaints"])
        uc_assign(["Assign Complaint to Worker"])
        uc_update_status(["Update Complaint Status"])
        uc_set_priority(["Set Complaint Priority"])
        uc_view_history(["View Complaint History"])
        uc_resolved_archive(["View Resolved Archive"])
        uc_send_digest(["Send Escalation Digest"])
        uc_create_staff(["Create Worker or Admin"])
        uc_list_workers(["List Workers"])
        uc_admin_reset(["Reset User Password"])
        uc_test_email(["Send Test Email"])

        uc_worker_dashboard(["View Worker Dashboard"])
        uc_accept(["Accept Assigned Complaint"])
        uc_start(["Start Work"])
        uc_resolve(["Submit Resolution"])
        uc_upload_resolution(["Upload Resolution Image"])
        uc_view_assigned(["View Assigned Complaints"])
        uc_view_resolved(["View Resolved Work"])

        uc_send_otp(["Send OTP Email"])
        uc_send_reset(["Send Password Reset Email"])
        uc_send_resolution_email(["Send Resolution Email"])
        uc_send_push(["Send Resolution Push Alert"])
    end

    citizen --> uc_register
    citizen --> uc_verify_otp
    citizen --> uc_login
    citizen --> uc_forgot
    citizen --> uc_reset
    citizen --> uc_subscribe
    citizen --> uc_create_complaint
    citizen --> uc_view_my
    citizen --> uc_view_detail
    citizen --> uc_track_status
    citizen --> uc_escalate
    citizen --> uc_feedback

    admin --> uc_login
    admin --> uc_admin_dashboard
    admin --> uc_view_all
    admin --> uc_filter_search
    admin --> uc_assign
    admin --> uc_update_status
    admin --> uc_set_priority
    admin --> uc_view_history
    admin --> uc_resolved_archive
    admin --> uc_send_digest
    admin --> uc_create_staff
    admin --> uc_list_workers
    admin --> uc_admin_reset
    admin --> uc_test_email

    worker --> uc_login
    worker --> uc_worker_dashboard
    worker --> uc_view_assigned
    worker --> uc_accept
    worker --> uc_start
    worker --> uc_resolve
    worker --> uc_view_resolved

    uc_register -. includes .-> uc_send_otp
    uc_verify_otp -. extends .-> uc_register
    uc_forgot -. includes .-> uc_send_reset
    uc_create_complaint -. includes .-> uc_upload_photo
    uc_view_my -. includes .-> uc_track_status
    uc_view_detail -. includes .-> uc_track_status
    uc_assign -. includes .-> uc_list_workers
    uc_update_status -. extends .-> uc_send_resolution_email
    uc_update_status -. extends .-> uc_send_push
    uc_send_digest -. includes .-> uc_view_all
    uc_resolve -. includes .-> uc_upload_resolution
    uc_resolve -. extends .-> uc_update_status
    uc_escalate -. extends .-> uc_send_digest
    uc_feedback -. extends .-> uc_track_status

    email --> uc_send_otp
    email --> uc_send_reset
    email --> uc_send_resolution_email
    email --> uc_send_digest
    email --> uc_test_email
    push --> uc_send_push
```

## Relationship Summary

| Actor | Main Use Cases |
| --- | --- |
| Citizen | Register, verify OTP, login, reset password, create complaints with images, view complaints, track status, escalate unresolved complaints, submit feedback, subscribe to notifications |
| Admin | View dashboard, view/search/filter complaints, assign workers, update status, set priority, view history, view resolved archive, send escalation digest, create staff, list workers, reset user passwords, test email |
| Worker | View dashboard, view assigned complaints, accept complaint, start work, submit resolution with image, view resolved work |
| Email Service | Sends OTP, password reset, complaint resolution, escalation digest, and test emails |
| Push Notification Service | Sends complaint resolution push alerts |

## Prompt for ChatGPT

Use this prompt if you want ChatGPT to recreate or improve the use case diagram:

```text
Create a UML use case diagram for my project named "CleanCity Portal". The system is a smart civic cleanliness complaint portal. Place all actors outside the system boundary box and all use cases inside the box. Show clear relationships between actors and use cases.

Actors:
- Citizen
- Admin
- Worker
- Email Service
- Push Notification Service

Citizen use cases:
- Register Account
- Verify Email OTP
- Login
- Request Password Reset
- Reset Password
- Subscribe to Notifications
- Create Complaint
- Upload Complaint Image
- View My Complaints
- View Complaint Details
- Track Complaint Status
- Escalate Complaint
- Submit Feedback

Admin use cases:
- View Admin Dashboard
- View All Complaints
- Search and Filter Complaints
- Assign Complaint to Worker
- Update Complaint Status
- Set Complaint Priority
- View Complaint History
- View Resolved Archive
- Send Escalation Digest
- Create Worker or Admin
- List Workers
- Reset User Password
- Send Test Email

Worker use cases:
- View Worker Dashboard
- View Assigned Complaints
- Accept Assigned Complaint
- Start Work
- Submit Resolution
- Upload Resolution Image
- View Resolved Work

External service use cases:
- Email Service sends OTP email, password reset email, resolution email, escalation digest, and test email.
- Push Notification Service sends resolution push alerts.

Generate Mermaid.js code in Markdown. Use a system boundary named "CleanCity Portal System". Keep actors outside the box and use cases inside it. Use include or extend style relations where useful, such as Create Complaint includes Upload Complaint Image, Register Account includes Send OTP Email, Request Password Reset includes Send Password Reset Email, Submit Resolution includes Upload Resolution Image, and Update Complaint Status extends Send Resolution Email and Send Resolution Push Alert.
```
