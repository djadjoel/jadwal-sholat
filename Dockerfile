# Jadwal Sholat — image produksi (PHP 8.3 + Apache).
FROM php:8.3-apache

# Modul Apache: header keamanan, cache statis, kompresi, IP asli di balik reverse proxy.
RUN a2enmod headers expires deflate remoteip rewrite \
 && { \
      echo 'ServerTokens Prod'; \
      echo 'ServerSignature Off'; \
      echo 'TraceEnable Off'; \
      echo '<Directory /var/www/html>'; \
      echo '    AllowOverride All'; \
      echo '</Directory>'; \
      echo '# Percayai X-Forwarded-For hanya dari jaringan privat (mis. container Caddy).'; \
      echo 'RemoteIPHeader X-Forwarded-For'; \
      echo 'RemoteIPInternalProxy 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.1'; \
    } > /etc/apache2/conf-available/jadwal-sholat.conf \
 && a2enconf jadwal-sholat \
 && mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini" \
 && { \
      echo 'date.timezone = Asia/Jakarta'; \
      echo 'expose_php = Off'; \
      echo 'display_errors = Off'; \
      echo 'log_errors = On'; \
    } > "$PHP_INI_DIR/conf.d/jadwal-sholat.ini"

WORKDIR /var/www/html

# Salin hanya berkas yang dibutuhkan aplikasi.
COPY --chown=www-data:www-data .htaccess index.html api.php sw.js manifest.webmanifest ./
COPY --chown=www-data:www-data assets/ ./assets/
COPY --chown=www-data:www-data src/ ./src/

RUN mkdir -p storage/cache storage/ratelimit \
 && chown -R www-data:www-data storage

VOLUME ["/var/www/html/storage"]
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1/ -o /dev/null || exit 1
