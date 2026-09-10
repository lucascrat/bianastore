FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

# Every deploy self-heals: idempotent migration, guarded seed, guarded
# test-residue cleanup, then start.
CMD ["sh", "-c", "node db/migrate.js && node db/seed.js && node db/cleanup.js && node index.js"]
