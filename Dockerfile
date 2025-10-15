FROM node:20-alpine

# Install CA certs so HTTPS works
RUN apk add --no-cache ca-certificates && update-ca-certificates

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
