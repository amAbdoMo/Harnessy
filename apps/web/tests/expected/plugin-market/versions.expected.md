## Update confirmation

- dialog "Update @fixture/bundle":
  - heading "Update @fixture/bundle" [level=2]
  - button "Close"
  - text: 0.0.1 0.0.2
  - term: Install from
  - definition: <fixture-registry>
  - paragraph: The update replaces 0.0.1 with 0.0.2 and takes effect after a restart. If installation fails, recovery reinstalls 0.0.1.
  - button "Cancel"
  - button "Update"
## Restart required

- dialog "Update @fixture/bundle":
  - heading "Update @fixture/bundle" [level=2]
  - button "Close"
  - status: 0.0.2 installed; it takes effect after a restart The change takes effect at the next start
  - list:
    - listitem: Check 0.0.2
    - listitem: Install 0.0.2 from <fixture-registry>
  - button "Done"
