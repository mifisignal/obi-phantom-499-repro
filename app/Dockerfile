# One image serves the app, the peer, and the loadgen; the compose service picks
# the script. Node only, no dependencies, so nothing is fetched at build time
# beyond the pinned base image.
FROM node:24-bookworm-slim
WORKDIR /srv
COPY server.js /srv/server.js
USER node
ENTRYPOINT ["node", "/srv/server.js"]
