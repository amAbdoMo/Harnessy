# Agent Note: File drag ownership outside the application layout

Status: implemented

English | [中文](2026-10-19-image-drag-plugin-ownership.zh.md)

## Problem

Original-file dragging spans conversation images, Markdown, sidebar previews and composer drop targets. A drag may outlive its source component, and its failure feedback may need to remain visible after the source panel closes. Putting this state in layout creates an image-specific dependency in a generic owner; a React provider also requires independent image entries to share an ancestor.

## Decision

The [file-drag plugin](../../../../packages/client/ui-file-drag/README.md) owns preparation, application-local browser tokens, retained original files, native bridge selection and localized failure feedback. Entries receive explicit callbacks through their existing injection faces. The plugin presents feedback through `shell.overlay`; layout declares that generic slot without importing image behavior. The shared image primitive owns gestures and caller cancellation. MIME naming and transport accept generic files, with images as their current presentation consumers.

Desktop resource borrowing requires Session-scoped Host read authorization and an unchanged local file. Main retains the exact window and Host generation with each preparation; its private bridge returns opaque handles to the renderer. The [Desktop owner](../../../../apps/desktop/README.md) defines preparation bounds, temporary-file retention and shutdown behavior.

## Alternatives considered

**Layout or renderer React provider.** Rejected: it couples a generic application owner to file transfers and adds an ancestor requirement absent from entry registration.

**State on each source image.** Rejected: removing a source would retire its retained bytes and feedback before another entry completes the transfer. The application owner keeps an active drag alive independently of the source component.

**Renderer-supplied native paths.** Rejected: a product document cannot authorize Host filesystem access. Resource addresses pass through the composed filesystem and Session; Main verifies the resulting private path and content identity without exposing that path to renderer JavaScript.

## Consequences

Independent render roots share transfers within one plugin instance. Managed tokens resolve only in that instance and are accepted only over the composer; external file drops retain their existing intake. Disposal cancels browser reads, clears retained transfers and suppresses late native feedback. Hiding a Desktop window to the tray retains the native owner; actual quit and confirmed installation release it, and a failed installation restores registration. External browser and cross-window delivery remain outside the verified same-instance transfer guarantee.
