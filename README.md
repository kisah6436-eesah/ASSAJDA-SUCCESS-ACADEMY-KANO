# Assajda Success Academy Kano — School Portal

A Node.js and SQLite school portal with private student, teacher, and administrator accounts. Records, class updates, and messages are stored on the server and shared by users connected to that server.

## Requirements

- Node.js 22.13 or newer. The server uses Node's built-in `node:sqlite`; no npm packages are needed.
- Keep the server running on a trusted computer. All users must connect to the same server to share records.

## Start the server

Open PowerShell in this project folder and run:

```powershell
node --version
node server.js
```

Open <http://127.0.0.1:4173/>. On first visit, create an administrator user ID; the initial password is `pass`. This password is weak—replace it with a strong password as soon as possible. There are no default administrator IDs.

If PowerShell says the port is already in use, close the other portal server or choose a different port, for example:

```powershell
$env:PORT = "4174"
node server.js
```

Then open <http://127.0.0.1:4174/>.

## Deploy on Render

Create a **Node Web Service** connected to this repository's `main` branch. Use the repository root as the root directory, `npm install` as the build command, and `npm start` as the start command. Render supplies `PORT`; set these environment variables:

- `HOST=0.0.0.0`
- `NODE_ENV=production`
- `DATA_DIR=/var/data`
- `ADMIN_SETUP_KEY` to a unique random secret of at least 32 characters. Keep it in Render's environment settings, not in the repository. Enter this key in the one-time setup form to create the administrator.

Attach a persistent disk mounted at `/var/data`. Without it, the SQLite database and all school records are lost on service restarts or redeploys. Render persistent disks require a paid web service.

The initial administrator setup uses the temporary password `pass`. Create the administrator immediately after the first deploy and change the password before sharing the public URL. Keep `ADMIN_SETUP_KEY` configured so setup stays protected if the database is reset. Do not enter real student information until you have confirmed persistent storage and backups.

## Create and manage accounts

- **Teachers:** Sign in as administrator, open **Teachers**, then **Add teacher**. Assign a subject from Mathematics, English, Physics, Biology, Islamic Studies, or ICT, or choose **Other** and enter a subject. The assigned subject appears in the teacher list. New teacher accounts use the initial password `pass`. Teachers cannot change their own passwords; an administrator can reset them from the teacher list.
- **Students:** Sign in as administrator, open **Students**, then **Add student**. New student accounts use the initial password `pass`. Students cannot change their own passwords; an administrator can reset them from the student list.
- **Profile photos:** Administrators can upload or replace teacher and student photos from the respective account lists. JPG, PNG, and WebP files up to 1 MB are accepted.
- **Change password:** Only administrators can change their own password from the top bar. Teacher and student passwords are managed by an administrator. New accounts and admin password resets use `pass`.

## Student and teacher features

- Teachers can publish typed class notes and exam updates for a selected class. Students see only updates for their own class.
- Teachers can attach a PDF to an update (PDF only, maximum 2 MB). The server checks the PDF signature and serves it only to an authorized user.
- Students can send private messages, including emojis, to a selected teacher. Only the student and recipient teacher can read that conversation; teachers can reply.
- Teachers can send recommendations to the administration. Administrators can review them on the administrator dashboard; students cannot access them.
- Teacher accounts are not restricted to particular classes in this version. Any active teacher can publish to any listed class.

## Access from other devices

Use only a trusted private network. On the server computer, stop the local server with Ctrl+C, then run:

```powershell
$env:HOST = "0.0.0.0"
node server.js
```

Allow TCP port 4173 through the server computer's private-network firewall. Find its private IPv4 address with `ipconfig`; other users on the same trusted network can then open `http://SERVER-IP:4173/`, replacing `SERVER-IP` with that address.

The default server is intended for local/private-network use. Do not expose it directly to the public internet. Public deployment requires HTTPS, a properly configured reverse proxy, server hardening, monitoring, and appropriate privacy safeguards.

## Data and privacy

- The database is created in `data/assajda.sqlite` by default. `DATABASE_PATH` or `DATA_DIR` can override its location.
- Keep the `data` directory on persistent, access-controlled storage, not a public folder or shared network drive.
- Stop the server cleanly before copying the SQLite database for backup. Backups contain sensitive student information and must be protected.
- Passwords are stored as salted scrypt hashes. Session cookies are HttpOnly and SameSite; write requests use CSRF protection.
- The default password `pass` is intentionally weak and must only be used temporarily. Change it to a unique strong password before using real student information.
- This is a small-school starting point, not a fully audited production system. Follow applicable privacy and child-protection rules, limit staff access, and use secure HTTPS infrastructure before internet-facing use.

## Older workspace link

The legacy `javascript/msmr.html` link redirects to this project. Run `node server.js` in this folder and open the server URL; do not enter real student information into a copied, standalone HTML demo.
