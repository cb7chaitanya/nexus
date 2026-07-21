# Self-hosted Postgres for platforms that can't bind-mount a local file
# into docker-entrypoint-initdb.d the way docker-compose.prod.yml does
# (e.g. Railway, which builds from this Dockerfile in the repo rather
# than composing local files) — bakes init.prod.sh into the image instead
# of mounting it. Same image, same init script, same behavior as the
# docker-compose deployment; this is packaging, not a second
# implementation.
FROM pgvector/pgvector:pg16

COPY infra/postgres/init.prod.sh /docker-entrypoint-initdb.d/init.sh
