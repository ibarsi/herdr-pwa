FROM node:26-alpine

WORKDIR /app

# No npm install: this project has no dependencies, by design.
COPY package.json herdr.js feed.js theme.js themes.json server.js ./
COPY static/ ./static/

ENV PORT=8787
EXPOSE 8787

# Default uid 1000 matches a typical Linux desktop user who owns Herdr's 0600
# socket. Compose overrides this with HERDR_UID / HERDR_GID.
USER 1000:1000

CMD ["node", "server.js"]
