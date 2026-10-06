#!/usr/bin/env python3
"""Convierte la salida JSON de `seed-dev` en el texto de .dev-credentials (usuarios y contraseñas de DESARROLLO)."""
import datetime
import json
import sys

d = json.load(sys.stdin)
print("# Credenciales de DESARROLLO · generadas", datetime.datetime.now().strftime("%Y-%m-%d %H:%M"))
print("# Las contraseñas solo existen aquí (en la base de datos hay únicamente su hash). Para generar otras: ./deca seed-dev --reset-passwords")
print("# Los usuarios de oficina (admin.dev, oficina.dev) deben configurar la verificación en dos pasos en su primer acceso.")
for user, pw in d["credentials"].items():
    print(f"{user:16} {pw if pw else '(ya tiene contraseña; no se puede recuperar)'}")
