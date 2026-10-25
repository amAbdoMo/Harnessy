---
name: office-export-pdf
description: Convert an Office document to a requested PDF with LibreOffice Kit.
---

# Export an Office document to PDF

Use the installed LibreOffice Kit CLI through the shell with the absolute Node and CLI paths supplied below. In Bash, invoke `"<node>" "<cli>"`; in PowerShell, invoke `& "<node>" "<cli>"`. Use only Harnessy’s bundled LibreOffice unless the user explicitly requests another installation. If the bundled Office sidecar is missing or fails, report the unavailable operation; installing or selecting another renderer requires an explicit user request. Do not invoke system soffice, use npx, or install a replacement to work around a failed conversion with an installed sidecar.

Convert the final saved Office file to a new PDF in the task workspace. Preserve the source. Quote each input and output path.

```text
"<node>" "<cli>" convert --input <final-office-file> --output <new-file.pdf>
```

Check the command result, nonempty output, and `%PDF-` file signature, then report that extent of validation. Unless the user requests deeper checks, do not search for PDF readers, generate images, or install tools to validate a conversion. Spreadsheet PDF pages follow workbook print settings; change those settings only when requested. Conversion may differ from the native application's pagination or fonts.

If export fails, preserve the usable source and report the export limitation. Do not repeatedly convert an unchanged source or use conversion to investigate a failed preview. For PDF export alone, stop after these checks. Only a request for images or visual inspection calls for `office-render`; load it before that separate operation. Deliver the requested PDF through `present` when available, keeping the file in place.
