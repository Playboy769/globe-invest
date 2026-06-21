#!/bin/sh
cp -r /app-src/* /usr/share/nginx/html/
exec /docker-entrypoint.sh nginx -g 'daemon off;'
