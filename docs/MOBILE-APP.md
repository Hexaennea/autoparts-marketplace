# PartPilot mobile app (Android, later iOS)

The app in `mobile/` is a [Capacitor](https://capacitorjs.com) shell: it opens the PartPilot website
inside a native app and adds what a website can't do as well, chiefly **push notifications** with
sound on the phone. Every page, login and order flow is the website itself, so a website deploy
updates the app too; only native changes (icon, permissions, plugins) need a new app build.

| Item | Value |
| --- | --- |
| App ID (permanent) | `com.harsivautotech.partpilot` |
| App name | PartPilot |
| Website it opens | `server.url` in `mobile/capacitor.config.json` (the Cloud Run test site for now; change to the live domain before Play Store) |
| Firebase project | PartPilot, `partpilot-b6b87` (Spark / free) on harsivautotechpvt@gmail.com |

## How push works

1. A signed-in user taps **Turn on notifications** (bell panel, or the Notifications page; sellers:
   Seller portal -> Notifications). The browser or phone asks for permission.
2. The device gets a Firebase token and the site registers it: `POST /api/push/devices`
   (`platform` = `web`, `android` or `ios`). Signing out removes it; signing in as someone else on
   the same device moves it to them.
3. Order events write a notification and queue one push per device (`push_outbox`); the server's
   worker sends them through Firebase (`server/src/services/push.ts`).
4. Web: the service worker `frontend/src/sw/firebase-messaging-sw.ts` shows it and opens the
   notification's page on click. App: Android shows it on the **Order updates** channel with sound;
   a tap opens the page.

The website parts (Firebase web config and the Web Push / VAPID key in
`frontend/src/lib/firebase-config.ts` and `lib/push.ts`) are public by design.

## Server key (needed to actually send pushes)

Firebase console -> Project settings -> **Service accounts** -> **Generate new private key** downloads
a JSON key. It is a secret: anyone holding it can send pushes as PartPilot.

* Cloud Run: store it in Secret Manager and expose it as `FCM_SERVICE_ACCOUNT` (the JSON text).
* Local development: put the file outside the repo and set `FCM_SERVICE_ACCOUNT_FILE=<path>` in
  `server/.env`.

Without it, pushes are recorded as `skipped` and the in-app bell still works.

## Building the Android app

One-time setup on the build computer:

1. Install **Android Studio** (it brings the Android SDK and Java).
2. Firebase console -> Project settings -> General -> *PartPilot Android* -> download
   **google-services.json** and save it as `mobile/android/app/google-services.json`
   (without it the app builds but push does not work).

Then:

```powershell
cd mobile
npm install
npx cap sync android
npx cap open android
```

In Android Studio: **Build -> Build App Bundle(s) / APK(s) -> Build APK(s)**. Copy the APK to an
Android phone and install it to test (allow "install unknown apps" once). The Play Store needs a
signed **App Bundle** (`.aab`) and a Google Play Developer account (one-time USD 25).

## iOS (later)

Needs an Apple Developer account (USD 99/year), a Mac with Xcode, `npx cap add ios`, and an APNs
key uploaded in Firebase -> Project settings -> Cloud Messaging -> Apple app configuration.
