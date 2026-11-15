# Mogul Clip

A Google Chrome extension that clips the page you're on into Mogul, as a note on your account.
The popup fills in the page's title and URL, and whatever text you've selected on the page; you can edit all three before saving.
Clips show up in the studio's notes sidebar.

## installation

Go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select this directory.
After changing a file, click the reload icon on the extension's card.

## how it works

The popup talks to the gateway exactly as the studio does.
It sends the gateway's session cookie with each request (`credentials: 'include'`), so being signed in to the studio in the same browser is all it needs.
The footer picks the server: local (`http://127.0.0.1:1010`) or production (`https://studio.mogul.tools`).

A clip is a `Note` whose owner is the mogul itself (`createNote(type: "mogul", ...)`) with a `title`, a `url`, and the note text.

To debug the popup, right-click inside it and choose **Inspect**.

## to resolve

* **clipping from a phone, or from outside Chrome** - this needs a long-lived token (personal access tokens in the gateway) rather than a browser session.
* **search** - the studio's Cmd-K search, in the popup, to find content that notes can attach to.

The fonts in `fonts/` are from the studio (Space Grotesk and IBM Plex, both under the SIL Open Font License; see the licenses alongside them).
