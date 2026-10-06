FROM alpine:3.20
RUN apk add --no-cache restic postgresql16-client bash coreutils
COPY decargo-backup.sh /usr/local/bin/decargo-backup
RUN chmod +x /usr/local/bin/decargo-backup
ENTRYPOINT ["/usr/local/bin/decargo-backup"]
