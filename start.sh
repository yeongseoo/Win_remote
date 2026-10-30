#!/bin/sh
# guacd 를 백그라운드로 띄우고 웹 서버를 실행
/opt/guacamole/sbin/guacd -b 127.0.0.1 -l 4822 -L info -f &
exec node server.js
