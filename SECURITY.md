# Security policy

PST Viewer opens mail from people you have never met. A mailbox, `.msg` or
`.eml` file is untrusted input, so anything that lets a crafted file break out
of the viewer, mislead the person reading it, or send data off their device is
treated as a security issue.

## Supported versions

There are no versioned releases. Fixes go to `main` and from there straight to
the hosted app at https://bod09.github.io/pst-viewer/ and the published Docker
image. Please test against the current version before reporting.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately instead:

**https://github.com/bod09/pst-viewer/security/advisories/new**

That keeps the details private until a fix is out. It helps to include:

- what an attacker can do, and what they need (a crafted file, a click, a setting)
- a minimal sample file, using made-up content only, never real mail
- the browser and version you saw it in

You will hear back once the report has been read, and be kept up to date while
it is worked on. Credit in the fix is yours if you want it.

## What counts

Things that are in scope include:

- script or markup in an email escaping the sandboxed frame it is shown in
- an email reaching the network when "Load images from the internet" is off,
  or anything else that sends mailbox contents off the device
- a crafted file making the viewer show the wrong sender, recipient or content,
  for example an address hidden inside an encoded display name
- an attachment or exported file (`.eml`, PDF) carrying something that was not
  in the original message, or losing something that was
- a file that crashes or hangs the app far out of proportion to its size

## What does not

- Problems that need an already compromised browser, a malicious extension, or
  physical access to an unlocked machine.
- Misconfiguration of a self-hosted deployment, unless the shipped defaults
  (the Docker image and `docker/` config) are what is at fault.
- A sender choosing a misleading display name in plain text. Every mail client
  shows display names as written; the issue is only when the *address* shown
  is not the real one.
