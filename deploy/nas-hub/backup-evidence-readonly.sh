#!/usr/bin/env bash
# READ-ONLY search for evidence of an independent (off-NVMe) Jarvis backup. It reads names,
# sizes, modification times and timer definitions only, never file contents. No sudo needed:
#   ssh robin@192.168.1.145 'bash -s' < deploy/nas-hub/backup-evidence-readonly.sh > nas-hub-backup-evidence.txt
set -uo pipefail
s() { printf '\n===== %s =====\n' "$1"; }
s "block devices and mounts (is any disk other than the NVMe present or mounted?)"
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL,TRAN 2>&1
findmnt -rn -o TARGET,SOURCE,FSTYPE 2>&1 | grep -v -E '^/(sys|proc|dev|run)' | head -30
s "systemd timers and unit files whose name suggests a backup"
systemctl list-timers --all --no-legend 2>&1 | head -30
systemctl list-unit-files --no-legend 2>&1 | grep -i -E 'backup|restic|borg|rclone|rsync|duplicati|kopia|snapshot' || echo "(none)"
s "cron"
ls -la /etc/cron.d /etc/cron.daily /etc/cron.weekly 2>&1 | head -30
crontab -l 2>&1 | grep -v '^#' | head -20
s "Jarvis tree: file NAMES that look like backups or backup tooling (no content)"
for d in /opt/nas /opt /srv /home/robin; do
  if [ -d "$d" ]; then
    echo "-- $d"
    find "$d" -maxdepth 4 \( -iname '*backup*' -o -iname '*restic*' -o -iname '*borg*' -o -iname '*rclone*' -o -iname '*rsync*' -o -iname '*.tar.gz' -o -iname '*.tar.zst' -o -iname '*.sql*' \) -not -path '*/node_modules/*' -printf '%TY-%Tm-%Td %TH:%TM %9s %p\n' 2>/dev/null | sort -r | head -20
  fi
done
s "containers that would do backups"
docker ps -a --format '{{.Names}} {{.Image}}' 2>&1 | grep -i -E 'backup|restic|borg|duplic|kopia|rclone' || echo "(none)"
s "remote copy tool configuration (directory names only)"
ls -la ~/.config/rclone ~/.config/restic ~/.config/borg 2>&1 | head -10
s "tailscale peers (names only): is another node a copy target?"
tailscale status 2>&1 | awk '{print $2, $4}' | head -20
s "end"; echo "no content was read; absence here means not found by these probes, not that no backup exists"
