# The nightly backup job (docs/runbooks/backups.md). pg_dump must be at least the
# server's major version; 17 can dump 16 and 17.
FROM postgres:17-alpine
RUN apk add --no-cache aws-cli
COPY deploy/backup/backup.sh deploy/backup/restore-check.sh /usr/local/bin/
CMD ["backup.sh"]
