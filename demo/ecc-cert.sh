#!/bin/bash

NAME='localhost'

if [ $# -gt 0 ] ; then
    NAME=$1
fi

# 当前openssl无法生成基于SM2的ECC证书，会提示无法读取私钥错误

#生成私钥
#openssl ecparam -genkey -name prime256v1 -out "$NAME.key"

#若要基于私钥生成公钥请执行
#openssl ec -in "$NAME.key" -pubout -out "$NAME.pub"

openssl ecparam -genkey -name prime256v1 | openssl ec -out "$NAME.key"

#生成证书请求文件
#openssl req -new -sha256 -out "$NAME.req" -key "$NAME.key"
openssl req -new -out "$NAME.req" -key "$NAME.key"

openssl x509 -req -in "$NAME.req" -out "$NAME.cert" -signkey "$NAME.key" -days 3650

