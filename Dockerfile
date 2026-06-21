FROM nginx:1.25-alpine
ENV PORT=8080
COPY app/globe/index.html /app-src/globe/index.html
COPY app/invest/index.html /app-src/invest/index.html
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
