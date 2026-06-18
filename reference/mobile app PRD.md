# Product Requirements Document: Daily Auto-Montage Social App

## 1. Product Summary

The product is a mobile-first social app for private friend groups where users capture or upload photos and videos throughout the day, and the app automatically turns that day’s media into a short 30-second montage.

Each user gets their own individual daily montage. Once published, the montage appears in a shared feed for their friends or groups to view, react to, and comment on. The montage remains live for 24 hours, after which it is automatically deleted from the server.

The app should feel natural, lightweight, and low-effort. The user should not feel like they are editing content. They should feel like they are simply capturing moments, and the app handles the rest.

## 2. Product Positioning

The app combines:

* The authenticity and daily habit of BeReal
* The casual social browsing of Threads
* The visual polish of Instagram posts
* The temporary nature of Snapchat/Stories
* Automatic video creation so users do not manually edit

Core positioning:

> Capture today. Get a 30-second recap. Share it with your close circle. Gone tomorrow.

## 3. Core Product Loop

1. User captures or uploads moments from today.
2. App stores the media temporarily in a private daily bucket.
3. User generates a 30-second auto montage.
4. User reviews and removes anything they do not want included.
5. User publishes the montage to their friend/group feed.
6. Friends react and comment.
7. The montage expires after 24 hours and is deleted from the server.

## 4. MVP Goal

The MVP should validate whether users enjoy creating and watching daily auto-generated recaps with their close friends.

The MVP should focus on:

* Private friend groups
* Individual daily montages
* 30-second auto-generated videos
* Today-only media uploads
* 24-hour expiry
* Simple social feed
* Reactions and comments
* Strict temporary storage behavior

## 5. Non-Goals for MVP

The following should not be included in the first release:

* Public profiles
* Public discovery feed
* Followers outside private groups
* Advanced manual video editing
* Complex AI editing
* Influencer/creator tools
* Monetization
* Permanent cloud archive
* Ads
* Brand accounts
* Long-form video editing
* Web app

## 6. Target Users

### Primary User

Young adults and friend groups who want an easy way to share daily life moments without manually editing videos or posting individual stories throughout the day.

### Secondary User

Friend groups on trips, parties, university life, office friend circles, or social communities who want daily memories without the effort of editing.

## 7. User Personas

### Persona 1: Casual Sharer

Wants to share daily life with close friends but does not want to spend time editing.

Needs:

* Simple capture
* Auto-generated recap
* Easy publishing
* Privacy

### Persona 2: Group Watcher

May not post every day but enjoys watching friends’ recaps.

Needs:

* Smooth feed
* Quick 30-second videos
* Reactions/comments
* No pressure to post

### Persona 3: Memory Saver

Likes the montage and wants to save it locally before it disappears.

Needs:

* Download to device
* Clear expiry timer
* No permanent server archive

## 8. Platforms

The app should be available on:

* iOS App Store
* Google Play Store

The product should be built as a mobile app first. Tablet support is optional for MVP.

## 9. Key Product Principles

### Low Effort

The user should not need to edit. The app should do the work.

### Temporary by Default

Raw media and final montages should not remain on the server permanently.

### Private First

MVP should focus on private friend groups, not public sharing.

### Today Only

Uploaded media must belong to the current day.

### Feed, Not Stories

The main social experience should be a clean daily feed, not story bubbles.

### Short and Watchable

The default montage should be 30 seconds.

## 10. App Structure

The MVP should have four primary areas:

### 1. Today

Where users capture/upload today’s media and generate their daily recap.

### 2. Feed

Where users watch friends’ published daily recaps.

### 3. Groups

Where users create, join, and manage private groups.

### 4. Profile/Settings

Where users manage account, privacy, notifications, blocked users, and app preferences.

## 11. Functional Requirements

---

# 11.1 Authentication and Onboarding

## Requirements

Users should be able to:

* Sign up using phone number, email, Apple login, or Google login
* Create a username
* Add profile photo
* Add display name
* Allow or skip contact discovery
* Accept terms of service and privacy policy
* Set notification preferences

## MVP Recommendation

Use:

* Phone number or email login
* Apple login for iOS
* Google login for Android/iOS

## Acceptance Criteria

* User can create an account successfully.
* User can log out and log back in.
* User can reset or recover access.
* User can delete their account.
* User must accept terms before using the app.

---

# 11.2 Friend Groups

## Requirements

Users should be able to:

* Create private groups
* Invite friends via invite link
* Join a group using an invite link
* View group members
* Leave a group
* Remove members if they are group owner/admin
* Rename a group
* Set group photo

## Business Rules

* MVP groups are private only.
* Group content is visible only to group members.
* A user can belong to multiple groups.
* A daily montage can be published to one or more selected groups.
* If a user leaves a group, they should no longer see that group’s active recaps.

## Acceptance Criteria

* User can create a group.
* User can invite another user.
* Invited user can join.
* Group feed only shows content from members.
* Non-members cannot access group content.

---

# 11.3 Today Media Bucket

## Description

Each user has a daily private media bucket where they collect photos and videos before generating their montage.

## Requirements

Users should be able to:

* Capture photos inside the app
* Capture videos inside the app
* Upload photos/videos from phone gallery
* View all media added for today
* Remove media before montage generation
* See whether enough content exists to generate a recap

## Business Rules

* Only media from the current local day should be accepted.
* The current day should be based on the user’s device timezone at the time of upload/capture.
* Gallery uploads must be validated using available metadata.
* If metadata is missing, invalid, or outside today’s date, the media should be blocked.
* In-app captured media is automatically valid for that day.
* Raw media is private until the user publishes a montage.

## Metadata Validation

For gallery uploads, the app should attempt to validate:

* EXIF date/time original
* Media creation date
* File creation date
* Device media library timestamp

If multiple timestamps exist, the backend should apply a validation hierarchy.

Suggested validation hierarchy:

1. Original captured timestamp from metadata
2. Device media library creation timestamp
3. File creation timestamp
4. Reject if no reliable timestamp exists

## Edge Cases

* Screenshot from today: allowed if timestamp is today.
* Edited photo from old date: should be rejected if original metadata shows old date.
* Metadata missing: reject for MVP.
* Timezone mismatch: use user’s current local day, but store all timestamps in UTC.
* User changes phone date/time: backend should compare with server time and flag suspicious uploads.

## Acceptance Criteria

* User can add valid same-day media.
* User cannot add media from previous days.
* User cannot add media with missing metadata.
* User can delete media from today’s bucket.
* Raw media is not visible to other users.

---

# 11.4 Montage Generation

## Description

The app automatically generates a short video montage from the user’s daily media.

## MVP Montage Length

Default: 30 seconds

Future options:

* 60 seconds
* 3-minute recap
* 5-minute recap

## Requirements

The system should:

* Generate a 30-second video using selected media
* Support both photo and video inputs
* Trim video clips automatically
* Show photos for a fixed duration
* Apply simple transitions
* Add background music
* Export a single final montage video
* Generate a preview before publishing

## MVP Editing Logic

For MVP, the montage engine can use rule-based editing:

* Prioritize videos over photos
* Trim videos into 1–3 second clips
* Display photos for 1–2 seconds
* Fit all selected content into 30 seconds
* Use chronological order by default
* Add simple transitions
* Apply selected music/theme
* Export in mobile-friendly aspect ratio

## Suggested Output Format

* Vertical 9:16 video
* 30 seconds
* Mobile-optimized quality
* Compressed for fast feed playback

## User Controls

Before publishing, users should be able to:

* Preview montage
* Remove media
* Regenerate montage
* Choose theme/vibe
* Choose music
* Download draft to device
* Publish

Users should not have a full video timeline editor in MVP.

## Acceptance Criteria

* User can generate a montage from valid daily media.
* Montage generation completes successfully.
* User can preview before publishing.
* User can regenerate.
* User can remove media and regenerate.
* Final montage is playable in the app feed.

---

# 11.5 Music and Themes

## MVP Requirements

Users should be able to choose from a small library of app-provided music and visual themes.

## Important Constraint

The MVP should use royalty-free or properly licensed music only.

## Suggested MVP Themes

* Chill
* Party
* Clean
* Travel
* Random
* Fast Cut
* Soft

## Acceptance Criteria

* User can select a theme.
* User can select music.
* Selected theme/music is applied to montage.
* App does not allow copyrighted commercial songs unless properly licensed.

---

# 11.6 Review and Publish Flow

## Requirements

After generating a montage, the user should see a review screen.

The review screen should include:

* Montage preview
* Selected date
* Expiry information
* Group selection
* Regenerate button
* Remove media option
* Download to device button
* Publish button
* Delete draft option

## Business Rules

* User must manually publish the montage.
* App should not auto-publish without user approval.
* User can publish only one daily recap per group per day.
* If user republishes, MVP should either block it or replace the previous recap.
* Recommended MVP rule: allow replacement before expiry.

## Acceptance Criteria

* User can preview final montage.
* User can select where to publish.
* User can publish to selected groups.
* Published montage appears in group feed.
* Raw media is deleted from server after successful publishing.

---

# 11.7 Feed

## Description

The feed is the main social surface where friends watch each other’s daily recaps.

## Requirements

The feed should show:

* Published recaps from friends/groups
* User display name
* Profile photo
* Date
* Expiry countdown
* 30-second video
* Reactions
* Comments
* Delete option for owner
* Download option for owner

## Feed Style

The feed should feel more like Instagram/Threads than Stories.

Recommended layout:

* Vertical scroll feed
* One recap card per user
* Autoplay muted preview
* Tap to watch with sound
* Reactions below video
* Comments below video
* Expiry countdown visible

## Business Rules

* Only group members can see group recaps.
* Recaps expire after 24 hours from publish time.
* Expired recaps should disappear from feed.
* Owner can delete their recap before expiry.
* Viewer cannot download another user’s montage in MVP.

## Acceptance Criteria

* User can view friends’ recaps.
* User can scroll feed smoothly.
* User can react.
* User can comment.
* Expired content is removed.
* Deleted content is removed immediately.

---

# 11.8 Reactions and Comments

## Requirements

Users should be able to:

* React to a montage
* Add comments
* Delete their own comments
* Report inappropriate comments
* Block users

## Suggested MVP Reactions

* Like
* Laugh
* Fire
* Heart
* Shocked

## Business Rules

* Reactions and comments expire with the montage.
* If montage is deleted, associated reactions/comments are deleted.
* Users can report content or comments.
* Blocked users should not be able to interact with each other.

## Acceptance Criteria

* User can react to a recap.
* User can comment on a recap.
* Owner receives notification.
* Comments disappear when recap expires.

---

# 11.9 Notifications

## Requirements

The app should support push notifications for:

* Daily capture reminder
* Reminder to generate recap
* Friend posted a recap
* Friend reacted to your recap
* Friend commented on your recap
* Montage expiring soon
* Group invite received

## Suggested Notification Schedule

* Afternoon reminder: “Add a few moments from today”
* Evening reminder: “Your recap is ready to create”
* Expiry reminder: “Your recap disappears soon. Save it if you want.”

## User Controls

Users should be able to:

* Enable/disable notifications
* Set reminder time
* Mute specific groups
* Mute interaction notifications

## Acceptance Criteria

* User receives relevant push notifications.
* User can disable notifications.
* Muted groups do not send push notifications.

---

# 11.10 Download and Save to Device

## Requirements

Users should be able to:

* Download their own montage to device while it is live
* Download draft montage before publishing
* Save directly to camera roll/gallery

## Business Rules

* Saving happens locally on the user’s device.
* The app should not provide permanent server archive in MVP.
* Users cannot download other users’ recaps in MVP.

## Acceptance Criteria

* User can download own montage.
* Downloaded video appears in device gallery.
* Server copy still expires after 24 hours.

---

# 11.11 Deletion and Retention

## Raw Media Lifecycle

Raw photos/videos are temporary.

### Before Publishing

Raw media is stored in the user’s private daily bucket.

Raw media should be deleted when:

* User removes it manually
* User publishes the montage successfully
* The daily window expires without publishing
* User deletes account
* User leaves app inactive beyond retention window

### After Publishing

Once the montage is published:

* Raw photos/videos used to create the montage should be deleted from server.
* Unused raw media from that day should also be deleted.
* Draft montage versions should be deleted.
* Only final published montage remains temporarily.

## Final Montage Lifecycle

Final montage is stored for 24 hours from publish time.

It should be deleted when:

* 24-hour expiry is reached
* User manually deletes it
* User deletes account
* Content is removed by admin/moderation

## Comments/Reactions Lifecycle

Comments and reactions should be deleted when:

* Montage expires
* Montage is deleted manually
* User deletes account
* Content is removed by admin/moderation

## Metadata Retention

The system may retain minimal non-content metadata for analytics and abuse prevention, such as:

* User ID
* Created timestamp
* Publish timestamp
* Expiry timestamp
* Processing status
* Error logs
* Report/moderation records

No raw media or final video should remain after deletion.

## Acceptance Criteria

* Raw media is deleted after publish.
* Final montage is deleted after 24 hours.
* Deleted media is not accessible via old URLs.
* Expired content disappears from feed.
* Deletion jobs are logged and auditable.

---

# 11.12 Reporting, Blocking, and Safety

## Requirements

Users should be able to:

* Report a montage
* Report a comment
* Block another user
* Leave a group
* Remove a user from a group if admin
* Delete own content

## Admin should be able to:

* View reported content before expiry where legally/technically available
* Remove reported content
* Suspend users
* Ban users
* Review abuse reports
* Export report logs if needed

## MVP Moderation Rules

* Private groups reduce moderation risk but do not remove the need for safety controls.
* Public profiles should not launch until moderation workflows are stronger.
* Report/block/delete must exist before App Store/Play Store launch.

## Acceptance Criteria

* User can report content.
* User can block another user.
* Admin can review reports.
* Admin can remove content.
* Blocked users cannot interact with each other.

---

# 11.13 Profile and Settings

## Requirements

Users should be able to:

* Edit display name
* Edit username
* Edit profile photo
* Manage notification settings
* Manage blocked users
* View joined groups
* Delete account
* Log out
* View privacy policy
* View terms of service

## Acceptance Criteria

* User can update profile.
* User can delete account.
* Deleted account triggers deletion of active media/content.
* User can access legal documents.

---

# 11.14 Admin Panel

## MVP Admin Features

Admin should be able to:

* Search users
* View user profile summary
* Suspend/ban users
* View groups
* View reported content
* Review report history
* Remove content
* View system processing status
* View failed montage jobs
* View storage usage
* View user growth and engagement metrics

## Acceptance Criteria

* Admin can review reports.
* Admin can remove content.
* Admin can suspend users.
* Admin can monitor processing failures.

---

# 12. Data Model Requirements

The technical team should define the final schema, but the product requires the following core entities:

## User

* User ID
* Display name
* Username
* Profile photo
* Email/phone
* Auth provider
* Created date
* Account status
* Notification preferences
* Privacy settings

## Group

* Group ID
* Name
* Photo
* Owner ID
* Created date
* Invite link/code
* Status

## Group Member

* Group ID
* User ID
* Role: owner/admin/member
* Joined date
* Status

## Daily Media Item

* Media ID
* User ID
* Date bucket
* Media type: photo/video
* Storage path
* Original timestamp
* Upload timestamp
* Validation status
* Processing status
* Duration
* Metadata summary
* Expiry timestamp

## Montage

* Montage ID
* User ID
* Date bucket
* Video storage path
* Thumbnail path
* Duration
* Status: draft/published/deleted/expired/failed
* Created timestamp
* Published timestamp
* Expiry timestamp
* Selected theme
* Selected music
* Processing job ID

## Montage Group Visibility

* Montage ID
* Group ID

## Reaction

* Reaction ID
* Montage ID
* User ID
* Reaction type
* Created timestamp

## Comment

* Comment ID
* Montage ID
* User ID
* Text
* Created timestamp
* Status

## Report

* Report ID
* Reporter ID
* Target type: montage/comment/user
* Target ID
* Reason
* Created timestamp
* Status
* Admin action

## Block

* Block ID
* Blocker user ID
* Blocked user ID
* Created timestamp

---

# 13. System States

## Daily Media Item States

* Uploaded
* Validating
* Valid
* Invalid
* Processing
* Used in montage
* Deleted
* Failed

## Montage States

* Not generated
* Generating
* Draft ready
* Published
* Failed
* Deleted by user
* Removed by admin
* Expired

## Report States

* Open
* Under review
* Actioned
* Dismissed

---

# 14. Infrastructure and Technical Considerations

The tech team should decide the final stack, but the product requires infrastructure for:

## Mobile App

* iOS app
* Android app
* Camera access
* Gallery/media library access
* Push notifications
* Local device save/download
* Video playback
* Background upload handling

## Backend API

Required capabilities:

* Authentication
* User management
* Group management
* Media upload authorization
* Media validation
* Montage creation request
* Feed retrieval
* Reaction/comment APIs
* Notification APIs
* Reporting/blocking APIs
* Admin APIs

## Object Storage

Required for:

* Temporary raw media
* Draft montage previews
* Published montage videos
* Thumbnails

Storage must support:

* Signed upload URLs
* Signed download/playback URLs
* Automatic expiry
* Deletion jobs
* Access control

## Video Processing

The system needs an asynchronous video processing pipeline.

Required capabilities:

* Queue montage generation jobs
* Process photos/videos
* Trim clips
* Stitch media
* Add transitions
* Add music
* Export final video
* Generate thumbnail
* Update job status
* Retry failed jobs
* Delete temporary files

## Job Queue

Required for:

* Montage generation
* Media validation
* Raw media cleanup
* Expired montage cleanup
* Notification dispatch
* Failed job retry
* Metadata extraction

## Database

Required for:

* Users
* Groups
* Memberships
* Media records
* Montage records
* Comments
* Reactions
* Reports
* Blocks
* Audit logs

## CDN

Required for:

* Fast video playback
* Thumbnail delivery
* Reduced storage bandwidth load

## Push Notification Service

Required for:

* iOS push notifications
* Android push notifications
* Reminder scheduling
* Interaction notifications

## Admin Panel

Required for:

* Moderation
* User management
* Content reporting
* Processing monitoring
* Operational analytics

---

# 15. Media Upload Requirements

## Upload Flow

1. User selects/captures media.
2. App checks basic client-side validity.
3. App requests upload URL from backend.
4. Media uploads to object storage.
5. Backend creates media record.
6. Metadata validation job runs.
7. Media becomes eligible or rejected.

## Upload Constraints

MVP should define limits for:

* Max photo size
* Max video size
* Max video duration
* Max number of daily media items
* Supported file formats
* Upload timeout
* Retry behavior

## Suggested MVP Limits

* Max video length per uploaded clip: 60 seconds
* Max daily media items: 50
* Max raw upload size per item: 200 MB
* Accepted photos: JPG, PNG, HEIC if supported
* Accepted videos: MP4, MOV
* Final montage: 30 seconds

---

# 16. Feed Ranking and Display

## MVP Feed Logic

Feed should be simple and chronological.

Sort by:

1. Published recaps from today
2. Most recent first
3. Group filter if selected

## Feed Card

Each feed card should include:

* User avatar
* User display name
* Date
* Expiry countdown
* Montage video
* Reaction count
* Comment count
* Comment preview
* Report button
* Delete button if owner

## Acceptance Criteria

* Feed loads quickly.
* Video playback starts smoothly.
* User can filter by group.
* Expired content is hidden.

---

# 17. Privacy Requirements

## Required Privacy Behaviors

* Raw media is private.
* Only final published montage is visible.
* Content is visible only to selected group members.
* Raw media is deleted after publish.
* Final montage is deleted after 24 hours.
* User can delete account.
* User can delete own content before expiry.
* User can block/report other users.
* The app must have a privacy policy.
* The app must disclose data collection for App Store and Play Store submissions.

## Sensitive Data

The app may process:

* Photos
* Videos
* Audio from videos
* Profile information
* Comments
* Reactions
* Device push token
* Usage analytics
* Media metadata

The team should treat this as sensitive user-generated content.

---

# 18. Security Requirements

## Requirements

* Authenticated access only
* Private media access via signed URLs
* No public raw media URLs
* Server-side authorization for every feed/media request
* Secure object storage permissions
* Rate limiting on uploads/comments/reactions
* Abuse prevention on invite links
* Secure deletion workflows
* Audit logs for admin actions
* Data encryption in transit
* Data encryption at rest
* Account deletion support

## Acceptance Criteria

* Users cannot access content from groups they are not part of.
* Expired media URLs no longer work.
* Deleted content cannot be accessed.
* Admin actions are logged.
* Upload endpoints are protected.

---

# 19. Performance Requirements

## Mobile App

* App should open quickly.
* Feed should load within acceptable mobile UX standards.
* Video playback should begin with minimal delay.
* Upload progress should be visible.
* Montage status should be visible.

## Backend

* Media uploads should not block API request threads.
* Montage generation should run asynchronously.
* Failed jobs should retry.
* Cleanup jobs should run reliably.
* Feed APIs should be optimized for mobile pagination.

## Video Processing

MVP should target:

* 30-second montage generation
* Predictable processing time
* Queue-based scaling
* Clear failure state if processing fails

---

# 20. Analytics Requirements

Track the following events:

## Acquisition

* App installed
* Signup started
* Signup completed
* First group joined
* First friend invited

## Activation

* First media captured
* First media uploaded
* First montage generated
* First montage published
* First recap viewed

## Engagement

* Daily active users
* Media items added per day
* Montages generated per day
* Montages published per day
* Feed views
* Average watch time
* Completion rate per montage
* Reactions sent
* Comments sent
* Groups active per day

## Retention

* Day 1 retention
* Day 7 retention
* Day 30 retention
* Posting streaks
* Group-level activity

## Operational

* Upload failures
* Montage generation failures
* Average processing time
* Storage used
* Cleanup job success/failure
* Expired media deletion count

---

# 21. MVP Success Metrics

The MVP should be considered successful if:

* Users create private groups.
* Users add media throughout the day.
* Users generate montages without manual editing.
* Users publish recaps repeatedly.
* Friends watch and react.
* Groups show repeat usage over multiple days.

Suggested target metrics:

* 40%+ of onboarded users join or create a group.
* 30%+ of users generate at least one montage.
* 20%+ of users publish a montage within first 3 days.
* 50%+ of published montages receive at least one view.
* 25%+ of users return the next day.
* Montage generation failure rate below 5%.

---

# 22. MVP Release Scope

## Phase 1: Internal Alpha

Audience: founder/friends/internal testers

Features:

* Login
* Create group
* Invite friends
* Capture/upload today’s media
* Generate 30-second montage
* Preview montage
* Publish to group feed
* View feed
* React/comment
* Delete own recap
* 24-hour expiry
* Basic admin/reporting

Goal:

Validate whether the core loop is fun.

## Phase 2: Closed Beta

Audience: limited external users

Features:

* Better onboarding
* Improved feed UX
* More themes/music
* Push notifications
* Improved montage reliability
* Report/block flows
* Basic analytics dashboard

Goal:

Validate retention and group activity.

## Phase 3: Public MVP Launch

Audience: App Store/Play Store

Features:

* Stable mobile app
* Store-ready privacy policy
* Data safety disclosures
* UGC moderation/reporting
* Account deletion
* Production monitoring
* Scalable media processing
* Reliable deletion jobs

Goal:

Launch private-group daily recap app publicly.

---

# 23. Future Roadmap

## Future Feature Ideas

* Public profiles
* Public recap feed
* Follow system
* Group collaborative recap
* AI highlight detection
* Beat-synced editing
* Auto captions
* Location-based recap tags
* Travel/event mode
* Premium themes
* Premium music
* Longer recaps
* Private local archive
* Memories saved only on device
* Streaks
* Friend prompts
* Daily recap challenges
* Export to Instagram/TikTok/Snapchat
* Shared vacation recap
* Birthday/event recap mode

## Public Profiles Consideration

Public profiles should only be added after:

* Moderation tools are mature
* Reporting workflows are tested
* Blocking is reliable
* Content safety policies are clear
* Feed ranking/discovery rules are defined

---

# 24. Key Open Questions for Tech/Product Team

1. Should users be allowed to publish the same montage to multiple groups?
2. Should users be allowed to replace a published recap before expiry?
3. Should daily cutoff be midnight local time or a custom day window, such as 4 AM to 4 AM?
4. Should users with missing metadata be fully blocked from gallery uploads?
5. Should raw media delete immediately after publish or after a short recovery window?
6. Should comments/reactions be fully deleted or retained as anonymized analytics?
7. Should users be able to download only their own montage or also friends’ montages with permission?
8. Should music be app-provided only for MVP?
9. Should montage generation happen on-device, server-side, or hybrid?
10. What is the maximum acceptable montage processing time?
11. Should invite links expire?
12. Should private groups have admins beyond the creator?
13. Should the app support multiple daily recaps in the future?
14. Should the app have posting streaks or avoid gamification?
15. Should content be restorable after deletion, or should deletion be permanent immediately?

---

# 25. Recommended MVP Decision Defaults

To avoid ambiguity, the recommended defaults are:

* Individual montage per user
* Private groups only
* One recap per user per day per group
* 30-second montage
* Vertical 9:16 output
* Today-only media
* Reject gallery media with missing metadata
* Manual publish only
* Raw media deleted after successful publish
* Final montage deleted after 24 hours
* Owner can download own montage
* Other users cannot download someone else’s montage
* Feed-based viewing, not story bubbles
* Simple reactions and comments
* Report/block included from MVP
* Public profiles deferred

## Final MVP Statement

The MVP is a mobile app for private friend groups where each user collects photos and videos from the current day, generates a 30-second automatic montage, reviews and publishes it to a shared feed, and has the content automatically deleted from the server after 24 hours.

The product should feel effortless, private, temporary, and social.
