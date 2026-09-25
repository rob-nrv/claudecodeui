#!/usr/bin/env bash
# READ-ONLY inventory of a Debian host that will also carry the CloudCLI Hosted Relay
# (built for nas-hub). It changes nothing: no docker/compose/tailscale/systemctl mutation,
# no restart, no file written outside stdout. Container environments, labels, compose files
# and secrets are never printed (explicit format strings only).
#
#   ssh <user>@nas-hub 'bash -s' < deploy/nas-hub/audit-readonly.sh > nas-hub-audit.txt
#
# Run it as a normal user first; sections that need root say "needs root" and are skipped.
set -uo pipefail
section() { printf '\n===== %s =====\n' "$1"; }
run() { "$@" 2>&1 || echo "(unavailable: $*)"; }
have() { command -v "$1" >/dev/null 2>&1; }

section "identity and time"
run cat /etc/os-release | grep -E '^(PRETTY_NAME|VERSION_ID)='
run uname -mr
date -u +%FT%TZ
uptime -p; uptime -s 2>/dev/null

section "CPU and load (Jarvis services running)"
lscpu | grep -E 'Architecture|Model name|^CPU\(s\)|Thread|MHz|Flags' | sed -E 's/Flags:.*(avx2).*/Flags: (avx2 present)/;t;s/Flags:.*/Flags: (no avx2)/'
cat /proc/loadavg
if have vmstat; then vmstat 1 5 | tail -6; fi
if have sensors; then sensors 2>/dev/null | grep -E 'Package|Core 0' ; else echo "(lm-sensors absent)"; fi

section "memory and swap"
free -m
grep -E 'SwapTotal|MemAvailable' /proc/meminfo

section "disks (no content is read)"
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,ROTA 2>&1
df -hT -x tmpfs -x devtmpfs -x overlay 2>&1
echo "-- inode use"; df -i / 2>&1 | tail -1
if have docker; then echo "-- docker disk usage"; docker system df 2>&1 || echo "(needs docker group)"; fi
echo "-- mounts that look like an off-NVMe backup target (names only)"
findmnt -rn -o TARGET,SOURCE,FSTYPE 2>/dev/null | grep -Ei 'backup|usb|mnt|media|srv|nas' || echo "(none mounted)"

section "power, lid, battery (laptop hardware)"
for f in /sys/class/power_supply/*; do [ -d "$f" ] && echo "$(basename "$f"): $(cat "$f/type" 2>/dev/null) status=$(cat "$f/status" 2>/dev/null) capacity=$(cat "$f/capacity" 2>/dev/null) online=$(cat "$f/online" 2>/dev/null)"; done
grep -E '^\s*(HandleLidSwitch|HandleLidSwitchExternalPower|HandleLidSwitchDocked|HandleSuspendKey|IdleAction)' /etc/systemd/logind.conf /etc/systemd/logind.conf.d/*.conf 2>/dev/null || echo "(logind lid/idle defaults in effect: lid close may suspend)"
systemctl is-active sleep.target suspend.target hibernate.target 2>&1 | paste -sd' '
systemctl status sleep.target 2>&1 | grep -E 'Loaded' | head -1
if have powertop; then echo "(powertop present)"; fi
cat /sys/class/power_supply/BAT*/charge_control_end_threshold 2>/dev/null

section "network and connectivity"
ip -br addr 2>&1
ip route 2>&1 | head -5
ss -ltnH 2>&1 | awk '{print $4}' | sort -u
echo "-- default-route interface link"; for i in $(ip route | awk '/default/{print $5}' | sort -u); do echo "$i: $(cat /sys/class/net/$i/operstate 2>/dev/null) speed=$(cat /sys/class/net/$i/speed 2>/dev/null)"; done
echo "-- UDP listeners"; ss -lunH 2>&1 | awk '{print $4}' | sort -u | head -20

section "firewall (read-only)"
if [ "$(id -u)" = 0 ]; then
  have ufw && ufw status verbose
  have nft && nft list ruleset 2>&1 | head -80
  have iptables && iptables -S 2>&1 | head -60
else
  echo "needs root (sudo -n) for ufw/nft/iptables; trying passwordless sudo:"
  sudo -n true 2>/dev/null && { have ufw && sudo -n ufw status verbose; have nft && sudo -n nft list ruleset 2>&1 | head -80; } || echo "no passwordless sudo: firewall state NOT inspected"
fi

section "software versions"
have docker && docker --version
have docker && docker compose version 2>&1
have tailscale && tailscale version 2>&1 | head -2
have node && node -v || echo "node: not installed on host (Debian 13 repository ships Node 20; .nvmrc needs 22)"
have npm && npm -v
have git && git --version
have python3 && python3 --version
have make && make --version | head -1
have g++ && g++ --version | head -1 || echo "g++: absent (needed only for a host build; a Docker multi-stage build brings its own)"
have curl && curl --version | head -1

section "Docker: containers, restart policy, limits, published ports (no env, no labels)"
if have docker; then
  docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>&1
  echo "-- restart policy / memory limit / network mode (per container)"
  for c in $(docker ps -aq 2>/dev/null); do
    docker inspect --format '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}} mem={{.HostConfig.Memory}} cpus={{.HostConfig.NanoCpus}} netmode={{.HostConfig.NetworkMode}} privileged={{.HostConfig.Privileged}}' "$c" 2>&1
  done
  echo "-- live CPU/RAM per container"
  docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' 2>&1
  echo "-- networks"; docker network ls --format 'table {{.Name}}\t{{.Driver}}\t{{.Scope}}' 2>&1
  echo "-- subnets (avoid overlap with a new CloudCLI network)"
  for n in $(docker network ls -q 2>/dev/null); do docker network inspect --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' "$n" 2>&1; done
  echo "-- volumes (names only)"; docker volume ls --format '{{.Name}}' 2>&1 | head -50
  echo "-- compose projects"; docker compose ls 2>&1
  echo "-- docker daemon log driver / live-restore"; docker info --format 'logdriver={{.LoggingDriver}} liverestore={{.LiveRestoreEnabled}} rootdir={{.DockerRootDir}}' 2>&1
else
  echo "docker not found or not usable by this user"
fi

section "Tailscale (status only; nothing is served or funnelled by this script)"
if have tailscale; then
  tailscale status 2>&1 | sed -E 's/[0-9a-f]{2}(:[0-9a-f]{2}){5}//' | head -20
  echo "-- current serve/funnel configuration (read-only)"
  tailscale serve status 2>&1 | head -20
  tailscale funnel status 2>&1 | head -20
  echo "-- DNS / HTTPS certificate capability"
  tailscale status --json 2>/dev/null | grep -E '"(MagicDNSSuffix|CertDomains|Self)"' -A3 | grep -E 'MagicDNSSuffix|CertDomains|HostName|Capabilities|https' | head -10
else
  echo "tailscale not found"
fi

section "services, updates and reboot behaviour"
systemctl list-units --state=failed --no-legend 2>&1 | head -10
systemctl is-enabled docker tailscaled unattended-upgrades 2>&1 | paste -sd' '
grep -Rhs 'Automatic-Reboot' /etc/apt/apt.conf.d/ 2>/dev/null || echo "(no Automatic-Reboot setting found)"
journalctl --list-boots 2>/dev/null | tail -8 || echo "(journal boots not readable)"
last -x reboot 2>/dev/null | head -5

section "backup evidence (metadata only)"
echo "cron / timers that mention backup:"
{ crontab -l 2>/dev/null; cat /etc/cron.d/* 2>/dev/null; systemctl list-timers --all --no-legend 2>/dev/null; } | grep -i backup || echo "(none found)"
echo "Newest files in likely backup locations (name + mtime only):"
for d in /mnt /media /srv/backup /var/backups /backup; do [ -d "$d" ] && { echo "-- $d"; find "$d" -maxdepth 2 -type f -printf '%TY-%Tm-%Td %TH:%TM %s %p\n' 2>/dev/null | sort -r | head -3; }; done

section "end"
echo "read-only audit finished; no state was changed"
