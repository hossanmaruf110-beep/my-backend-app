FROM node:20-alpine

# Ghostscript ইনস্টল করার কমান্ড
RUN apk add --no-cache ghostscript

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 10000
CMD [ "node", "server-mongo.js" ]
