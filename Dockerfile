FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY db ./db
COPY scripts ./scripts
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
