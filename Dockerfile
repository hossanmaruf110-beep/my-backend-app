FROM node:20-alpine

RUN apk add --no-cache \
    ghostscript \
    fontconfig \
    ttf-dejavu \
    ttf-liberation \
    ttf-freefont \
    && fc-cache -f

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 10000

CMD [ "node", "server-mongo.js" ]
