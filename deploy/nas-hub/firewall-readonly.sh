#!/usr/bin/env bash
# READ-ONLY firewall and exposure listing for nas-hub. Needs root to read the rulesets and
# changes nothing. Run it interactively so that sudo can prompt you: the script is fed on
# stdin, the password is typed on the terminal (never in a file, never in the output):
#   ssh -t robin@192.168.1.145 'sudo bash -s' < deploy/nas-hub/firewall-readonly.sh > nas-hub-firewall.txt
set -uo pipefail
s() { printf '\n===== %s =====\n' "$1"; }
s "who"; id -un
s "forwarding"; sysctl net.ipv4.ip_forward net.ipv6.conf.all.forwarding 2>&1
s "ufw"; if command -v ufw >/dev/null; then ufw status verbose 2>&1; else echo "ufw not installed"; fi
s "nftables ruleset (truncated to 200 lines)"; if command -v nft >/dev/null; then nft list ruleset 2>&1 | head -200; else echo "nft not installed"; fi
s "iptables filter (IPv4)"; if command -v iptables >/dev/null; then iptables -S 2>&1 | head -80; else echo "iptables not installed"; fi
s "iptables DOCKER-USER chain (where a Docker-aware LAN restriction would live)"; iptables -S DOCKER-USER 2>&1 | head -20
s "iptables nat, published-port DNAT (IPv4)"; iptables -t nat -S 2>&1 | grep -E 'DNAT|DOCKER' | head -40
s "ip6tables filter (IPv6)"; if command -v ip6tables >/dev/null; then ip6tables -S 2>&1 | head -80; else echo "ip6tables not installed"; fi
s "ip6tables nat, published-port DNAT (IPv6)"; ip6tables -t nat -S 2>&1 | grep -E 'DNAT|DOCKER' | head -40
s "listening sockets with owning process"; ss -ltnpH 2>&1 | awk '{print $4, $6}' | sort -u
s "global IPv6 addresses (Internet-reachable only if the box allows inbound IPv6)"; ip -6 addr show scope global 2>&1 | grep -E 'inet6|^[0-9]+:'
s "end"; echo "read-only listing finished; no rule was changed"
