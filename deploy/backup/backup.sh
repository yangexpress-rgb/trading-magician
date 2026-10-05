#!/bin/sh
# Nightly database backup to Cloudflare R2 (docs/runbooks/backups.md, ADR 0025).
# Dumps the database in pg_dump's custom format, uploads it, checks the upload,
# and deletes backups older than BACKUP_KEEP_DAYS (30).
set -eu

: "${DATABASE_URL:?DATABASE_URL is required (the owner connection)}"
: "${R2_ENDPOINT:?R2_ENDPOINT is required, like https://<account id>.r2.cloudflarestorage.com}"
: "${R2_BUCKET:?R2_BUCKET is required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required (an R2 API token)}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required (an R2 API token)}"
PREFIX="${BACKUP_PREFIX:-${RAILWAY_ENVIRONMENT_NAME:-production}}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"

s3() { aws --endpoint-url "$R2_ENDPOINT" "$@"; }

stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
name="tm-$stamp.dump"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

echo "backup: dumping database"
pg_dump --format=custom --compress=6 --file="$work/$name" "$DATABASE_URL"
pg_restore --list "$work/$name" > /dev/null
size=$(wc -c < "$work/$name" | tr -d ' ')
echo "backup: dump is $size bytes"

echo "backup: uploading s3://$R2_BUCKET/$PREFIX/$name"
s3 s3 cp --only-show-errors "$work/$name" "s3://$R2_BUCKET/$PREFIX/$name"
uploaded=$(s3 s3 ls "s3://$R2_BUCKET/$PREFIX/$name" | awk '{print $3}')
if [ "$uploaded" != "$size" ]; then
  echo "backup: FAILED, uploaded size $uploaded differs from $size" >&2
  exit 1
fi

cutoff=$(date -u -d "@$(( $(date +%s) - KEEP_DAYS * 86400 ))" +%Y-%m-%dT%H%M%SZ)
s3 s3 ls "s3://$R2_BUCKET/$PREFIX/" | awk '{print $4}' | while read -r old; do
  case "$old" in
    tm-*.dump)
      taken=${old#tm-}
      taken=${taken%.dump}
      if [ "$taken" \< "$cutoff" ]; then
        echo "backup: deleting $old (older than $KEEP_DAYS days)"
        s3 s3 rm --only-show-errors "s3://$R2_BUCKET/$PREFIX/$old"
      fi
      ;;
  esac
done
echo "backup: done, $PREFIX/$name"
