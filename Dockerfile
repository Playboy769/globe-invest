FROM node:20-alpine
COPY app /app
COPY server.js /server.js
COPY auth.js /auth.js
EXPOSE 8080
CMD ["node", "/server.js"]
