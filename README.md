# 🖨️ DTF Stock Manager — Guía de instalación

## ¿Qué hace esta app?
- Lleva el stock de tus lisos por talle (S, M, L, XL, XXL, XXXL)
- Cuando entra un pedido pagado en Tiendanube, descuenta el talle automáticamente
- Si un talle llega a 0, cierra ese talle en **todos** los productos que tienen "liso" en el nombre
- Panel web para cargar stock cuando llega mercadería nueva

---

## PASO 1 — Subir a Railway

1. Andá a **railway.app** y creá una cuenta gratuita
2. Hacé clic en **"New Project"** → **"Deploy from local"**
3. Arrastrá la carpeta `dtf-stock` completa
4. Railway detecta automáticamente que es Node.js y lo deploya

---

## PASO 2 — Configurar variables de entorno en Railway

En tu proyecto de Railway → **Variables** → agregá estas:

| Variable | Valor | Dónde conseguirlo |
|----------|-------|-------------------|
| `TN_TOKEN` | tu access token | Tiendanube → Mis aplicaciones → Nueva app privada |
| `TN_STORE_ID` | número de tu tienda | Está en la URL del admin de tu tienda |
| `ADMIN_PASSWORD` | contraseña que quieras | La inventás vos (para entrar al panel) |
| `WEBHOOK_SECRET` | texto secreto | Lo inventás vos (para verificar que el webhook es de TN) |

---

## PASO 3 — Configurar el webhook en Tiendanube

1. En tu panel de Tiendanube → **Configuración** → **Notificaciones** → **Webhooks**
2. Hacé clic en **Agregar webhook**
3. URL: `https://TU-APP.railway.app/webhook` (Railway te da esta URL)
4. Evento: **order/paid** (pedido pagado)
5. En el campo "Token de seguridad" pegá el mismo valor que pusiste en `WEBHOOK_SECRET`
6. Guardá

---

## PASO 4 — Usar el panel

1. Abrí `https://TU-APP.railway.app` en el navegador
2. Ingresá la contraseña que configuraste en `ADMIN_PASSWORD`
3. Cargá el stock inicial de cada talle
4. ¡Listo! De ahora en más es automático

---

## Cómo detecta los lisos

La app busca todos los productos que tienen la palabra **"liso"** en el nombre (sin importar mayúsculas: "Remera Lisa", "LISO azul", etc.).

Los productos **sin** "liso" en el nombre **no se tocan** — tienen su propio stock en Tiendanube.

---

## Soporte

Si algo no funciona, revisá:
- Que el `TN_TOKEN` tenga permisos de lectura y escritura en productos y pedidos
- Que el `TN_STORE_ID` sea el número correcto (está en la URL del admin)
- El historial de eventos en el panel (pestaña "Historial")
