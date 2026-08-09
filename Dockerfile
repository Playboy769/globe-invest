FROM node:20-alpine
COPY app /app
COPY server.js /server.js
COPY auth.js /auth.js
COPY powerlog.js /powerlog.js
COPY fuelprice.js /fuelprice.js
EXPOSE 8080
CMD ["node", "/server.js"]
