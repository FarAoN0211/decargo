# Seguridad

Si encuentras una vulnerabilidad en DECARGO, **no abras una incidencia pública**. Escribe al responsable del proyecto por el canal privado de avisos de seguridad del repositorio (GitHub → Security → Report a vulnerability). Indica:
- qué has encontrado y cómo reproducirlo;
- qué versión o commit usas;
- el impacto que crees que tiene.

Se responderá lo antes posible. Hasta que haya una corrección publicada, no difundas el detalle.

Recomendaciones para quien instala DECARGO: mantén Docker y el sistema actualizados, publica solo a través de un proxy https, no expongas los puertos de la API ni de la base de datos a Internet, activa la verificación en dos pasos para todo el personal de oficina, haz copias de seguridad cifradas fuera del equipo y guarda la `RESTIC_PASSWORD` en lugar seguro.
