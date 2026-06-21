FROM node:20-alpine
COPY app /app
COPY server.js /server.js
EXPOSE 8080
CMD ["node", "/server.js"]
