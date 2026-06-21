FROM nginx:1.25-alpine
ENV PORT=8080
COPY app/globe/index.html /usr/share/nginx/html/globe/index.html
COPY app/invest/index.html /usr/share/nginx/html/invest/index.html
COPY nginx.conf /etc/nginx/templates/default.conf.template
EXPOSE 8080
