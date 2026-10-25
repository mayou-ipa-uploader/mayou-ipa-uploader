# Mayou IPA Uploader

**IPA uploads to App Store Connect · iOS certificates · Provisioning profiles · TestFlight**

[简体中文](README.md) · English

Mayou IPA Uploader (码友证书管理) is a desktop tool for iOS developers and app release teams. Upload a signed IPA to App Store Connect, manage signing materials, and follow build processing and TestFlight testing from one interface.

> **Source and license**: real client source code is available in [source](source/). First-party source is licensed under [MIT](LICENSE); third-party components retain their own terms. See [development notes](source/README.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

## Features

- **IPA upload**: read the Bundle ID, version and build number, select the target team, and submit a signed IPA.
- **Bundled upload runtime**: the upload flow does not require a separate installation of Xcode, Transporter, Python or Java.
- **Processing status**: inspect Apple processing results and errors, matching the app, version, build and upload receipt.
- **Signing materials**: prepare development and distribution certificates, P12 files and provisioning profiles for the selected workflow.
- **App and identifier management**: view apps, versions, Bundle IDs, certificates and profile expiration information.
- **TestFlight management**: view builds, manage test information, groups and testers, and inspect feedback.
- **Device management**: register, import, search, rename and disable test devices.
- **Review assistance**: select an app and connect with a support specialist. Apple determines review outcomes.

## Screenshots

Account details and application identifiers have been redacted.

### IPA upload

Select the IPA and upload credentials, then follow upload logs and processing results.

[![Mayou IPA Uploader: App Store Connect upload interface](docs/images/ipa-upload.png)](docs/images/ipa-upload.png)

### Certificates and provisioning profiles

Prepare signing materials for distribution or development, or download previously synchronized materials by bundle identifier.

[![iOS signing certificates and provisioning profile workflows](docs/images/one-click-certificates.png)](docs/images/one-click-certificates.png)

### TestFlight

Inspect build versions and testing states before arranging internal or external testing.

[![TestFlight build versions and testing states](docs/images/testflight.png)](docs/images/testflight.png)

[View all feature screenshots in the Chinese README](README.md#showcase).

## Getting started

1. Prepare a signed IPA for App Store distribution and a matching app in App Store Connect.
2. Sign in with an Apple developer account that can access and upload to the app.
3. Open the IPA upload page and check the Bundle ID, version, build number and target team.
4. Supply the upload credentials requested by the client, including an app-specific password when required.
5. Upload the file and query Apple's processing result.
6. Open TestFlight and complete any required compliance or testing information.

File submission, completed build processing, TestFlight availability and App Store approval are separate stages.

The Windows upload flow additionally requires AppStoreInfo.plist from the same export as the IPA.

## Downloads

| Platform | Availability |
| --- | --- |
| macOS · Apple Silicon | Package prepared: version 0.1.388, DMG |
| Windows | Adapted in the project; installer not yet provided in this repository |
| Intel Mac / Linux | No installer provided in this repository |

Check this repository's Releases for published packages. If no release is available yet, contact support below. For macOS, open the DMG and drag the app into Applications.

This tool accepts an already built and signed IPA. It does not compile Flutter, Unity or uni-app projects.

## Licensing and support

First-party client source in this repository is licensed under MIT. The repository does not include the Mayou server or Apple services. External runtimes and third-party materials retain their own terms. The source license does not make hosted services or support free. Trial availability, licensing and feature access follow the client and applicable service terms.

- **QQ community**: 1107258605
- **QQ support**: 1970332242
- **Issues**: include the app version, operating system, reproduction steps and redacted error details.

Do not include passwords, verification codes, session credentials, P12 passwords or private keys in reports.
