# SFTP access

SFTP and the web page serve **the same folder**. A file dropped through one is
immediately visible through the other, under its real name.

SFTP stays useful even with a web interface: it is the route with no request-size
limit at all, it copes best with a flaky line, and it lets you `rsync` from the
host itself.

## Why a second sshd instance

The sshd on port 22 also serves administrative access to the machine. Adding drop
accounts to its configuration would mean exposing that port to hand out SFTP —
putting the root login in the path of automated scanning. A separate instance,
with its own configuration and port, keeps the two worlds apart. The system's
sshd is not touched at all.

## Setup

```bash
# 1. Group and account, no shell
groupadd sftpusers
useradd -M -d /upload -s /usr/sbin/nologin -g sftpusers guest

# 2. Jail layout: the root MUST be root:root and not writable by anyone else,
#    or sshd refuses the chroot
install -d -o root -g root -m 755 /srv/depot/guest
install -d -o guest -g sftpusers -m 775 /srv/depot/guest/upload

# 3. Configuration and service
cp sftp/sshd_sftp_config.example /etc/ssh/sshd_sftp_config
chmod 600 /etc/ssh/sshd_sftp_config
sshd -t -f /etc/ssh/sshd_sftp_config          # check BEFORE starting
cp sftp/sshd-sftp.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sshd-sftp.service
```

`ChrootDirectory` puts the user in `/srv/depot/<account>`, and their home
`/upload` is the only place they can write. The folder served by the web page must
be that same `/srv/depot/<account>/upload`.

## Pitfalls

- **The chroot root must be owned by root and writable by root only.** OpenSSH
  requires it; otherwise the connection fails with no clear message on the client
  side.
- **Check the configuration with `sshd -t` before starting**, and keep a session
  open while you validate.
- The web container must run with the SFTP account's `uid`, or files dropped
  through one route cannot be managed through the other.
