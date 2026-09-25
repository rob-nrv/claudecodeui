# /etc/nginx/cloudcli-relay-proxy.inc. The relay reads the LAST X-Forwarded-For
# entry, so the header is REPLACED with the address nginx saw, never appended to
# whatever the client sent.
proxy_pass http://127.0.0.1:3443;
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
