# AbleSign Display Audio Notes

This project uses `/display` as a customer-facing signage page that may run inside AbleSign on a TV.

## What AbleSign Provides

AbleSign supports displaying websites as playlist content:

- AbleSign website content is loaded by the player when the playlist reaches that website.
- AbleSign recommends reliable internet for website content because the page is loaded online.
- AbleSign can pre-load a website before it appears in the playlist.
- AbleSign Web Player runs in a device browser.

References:

- [AbleSign: display a website](https://www.ablesign.tv/digital-signage/how-to-display-website-digital-signage/)
- [AbleSign: web player](https://www.ablesign.tv/digital-signage/web-player/)

## Audio Boundary

The web app cannot reliably force audible autoplay by itself. Modern browsers and WebViews can block audible media and Web Audio until the player environment allows autoplay or the page has a user gesture.

References:

- [MDN autoplay guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)
- [Chrome autoplay policy](https://developer.chrome.com/blog/autoplay/)

For a TV/signage install, do not rely on a visible "click to enable sound" button. The display may not have a pointer.

## Project Behavior

`/display` is designed for kiosk/signage use:

- It fetches one initial snapshot with `/api/display/tickets`.
- It receives order updates over WebSocket.
- It queues announcements so multiple ready events do not cancel each other.
- It keeps a persistent Web Audio engine alive when the player allows it.
- It runs a local audio health check so audio can recover if the player temporarily suspends it.
- If audio is blocked by the player, it shows a non-interactive status message: `Sound blocked. Allow autoplay/audio in AbleSign.`

## Setup Recommendation

When configuring AbleSign:

- Use the deployed `/display` URL as a Website item.
- Give the Website playlist item a long duration or make it the only playlist item for the pickup screen.
- Prefer the AbleSign Android/TV app over a generic browser when possible.
- In the AbleSign device/app/TV settings, allow sound/audio/autoplay if such a setting is available.
- Verify the TV volume, app volume, and Android media volume are all unmuted.

If a display shows the sound-blocked message, treat it as a player/device permission issue rather than an order or WebSocket issue.
