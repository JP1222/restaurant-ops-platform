# Support

**Effective Date:** May 21, 2026

**Last Updated:** May 21, 2026

This page describes how to get help with the **Example Kitchen Kitchen Display & Analytics Suite**, the app installed from the Clover App Market by a single restaurant merchant.

---

## 1. Who supports this Software

The Software is independently developed and operated by **Example Owner**, an individual sole-proprietor based in Anytown, ST, United States. Support is provided directly by the developer.

The Software is **not** a Clover product and is not supported by Clover. For Clover platform issues — POS hardware, payment processing, employee management, or any feature of the base Clover Dashboard — contact Clover through your Clover device or via [https://www.clover.com/help](https://www.clover.com/help).

---

## 2. How to reach support

- **Email**: [support@example.com](mailto:support@example.com)
- **Response time**: Best-effort, typically within one business day.

When reporting an issue, please include:

1. The Clover merchant ID and the device on which the issue occurred.
2. Approximate timestamp of the problem.
3. What you were doing in the app when the issue happened.
4. Any error message displayed on the KDS, customer display, or back-office screen.

---

## 3. Scope of support

Because this Software is built for a single-merchant deployment, support is limited to that merchant's installation. The developer does not provide:

- Custom feature development on demand.
- Training for staff beyond what is covered in the in-app interfaces.
- 24/7 on-call coverage.
- Migration of data into or out of the Software.

For incidents that block service during operating hours — for example, tickets not appearing on a KDS screen — email support and the developer will respond as soon as practical.

---

## 4. Self-service troubleshooting

| Symptom | Likely cause | First thing to try |
| --- | --- | --- |
| Orders not appearing on KDS | Clover webhook verification code rotated | Re-install the app from the Clover App Market to refresh credentials |
| KDS screen shows "disconnected" | Brief network blip on the kitchen tablet | Refresh the browser tab; the app reconnects WebSocket automatically |
| Analytics totals disagree with the Clover Dashboard | Mart sync lag | Wait up to 5 minutes; the analytics pipeline polls Clover on a schedule |
| Customer display is blank | Browser zoom or session lost | Reload the customer-display URL on the kitchen tablet |
| Back-office login fails after a device change | Passkey not registered on the new device | Sign in once on a known device, then enroll the new passkey from Settings |

---

## 5. Related documents

- **[End User License Agreement](/eula)** — terms under which the Software is licensed.
- **[Privacy Policy](/privacy)** — what personal information we collect, how we use it, and who processes it.

---

## 6. Contact

- **Developer**: Example Owner, d/b/a Example Kitchen
- **Email**: support@example.com
- **Postal**: Anytown, ST, United States
