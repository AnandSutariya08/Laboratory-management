# Lab machine connector

A small program for the Windows PC that your analysers are cabled to. It reads results from each analyser and
sends them to the lab app, where they appear in result entry under **Machine value**. If the internet drops,
results wait on this PC and are sent when it is back.

It works with analysers that send **ASTM** (most biochemistry, haematology, immunoassay and urine analysers) or
**HL7**, over a **serial cable** (COM port), the **network**, or **result files** saved to a folder.

## Before you start

- A Windows 10 or 11 PC that stays on during lab hours, with internet.
- **Node.js LTS** installed from https://nodejs.org (one time; accept the defaults).
- For each analyser, its LIS / host settings from the analyser's menu or manual: link type, protocol, and the
  COM port speed or the network port.
- In the lab app, the analyser added under **Quality Control > QC Setup > Machines** (or Lab settings >
  Machines), and the **machine code** of each test or parameter filled in (Tests > edit test). The codes must
  match what the analyser sends (for example `GLU`, `CHOL`, `HGB`).

## Install

1. Unzip this folder to `C:\HCL-Connector`.
2. In the lab app, open the analyser and choose **Connect analyser**. Make a token, pick how the analyser is
   linked, and copy the settings.
3. Double-click **setup.bat**. Notepad opens `config.json`: paste the settings over everything, save and close.
   Setup checks the token with the lab app, then installs the connector so it starts with Windows (it asks for
   administrator permission).
4. The status page opens at http://localhost:7300. Each analyser should show **listening** or **connected**,
   and **Accepted** for the lab app. In the lab app the analyser shows **Connected** within a minute.
5. Run one sample whose barcode is on a bill. Its values appear in result entry.

### More than one analyser

Add each analyser's block to the `machines` list in `config.json` (each has its own token from the app), then
run **restart.bat**.

## Link types

| `connection` | Use when | Settings |
|---|---|---|
| `serial` | RS-232 cable or USB-serial adapter | `serial.port` (`COM3`), `baudRate` and the other values exactly as set on the analyser. Run **list-ports.bat** to see the COM ports. |
| `tcp-server` | The analyser connects to the LIS (you enter this PC's IP and a port on the analyser) | `tcp.port`. Give this PC a fixed IP address. |
| `tcp-client` | The analyser waits for the LIS to connect (it shows its own IP and port) | `tcp.host`, `tcp.port` |
| `folder` | The analyser or its software exports result files | `folder.path`. Files are read when they stop growing, then moved to `sent-to-lab-app` (or `not-read` if they hold no results). ASTM, HL7, CSV and JSON files are recognised. A CSV needs a header row with columns for the sample barcode, test code and value. |

`protocol` is `astm` or `hl7`. If an older analyser sends frames with wrong checksums, add `"ignoreChecksum": true`.

## Everyday use

| File | What it does |
|---|---|
| `status.bat` | Opens the status page (http://localhost:7300) |
| `restart.bat` | Restart after changing `config.json` |
| `stop.bat` | Stop the connector |
| `uninstall.bat` | Stop it and remove it from Windows startup |
| `list-ports.bat` | List the COM ports on this PC |

## When something is wrong

The status page shows the last problem for each analyser. Common ones:

- **Cannot open COM3**: wrong port, the cable or USB adapter is unplugged, or another program (for example the
  analyser vendor's software) is using the port. Close the other program or use a different port.
- **Nothing received**: check the analyser's LIS / host communication is switched on and the speed, data bits,
  parity and stop bits match. For network links check the IP address, port and that both are on the same network.
- **Token refused**: the token was replaced or switched off in the app. Make a new one and update `config.json`.
- **Sample has no bill in the app**: the barcode on the tube did not match a bill. The result is kept in the
  app's unmatched list.
- **Code not mapped**: set that code as the machine code on the test or parameter in the app.

Logs are in `data\logs`. `raw-<machine>-<date>.log` holds the exact bytes each analyser sent (control
characters shown as `<STX>`, `<ETX>` ...): send it to support when setting up a new analyser model.

## Not included yet

- Sending the worklist to the analyser (the analyser asking the LIS which tests to run for a barcode). For now
  select the tests on the analyser. Such requests are noted in the log.
