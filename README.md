# 🕵️ Spyfall (ภาษาไทย) – เล่นฟรี, ไม่ต้องมีเซิร์ฟเวอร์, พร้อมดีพลอย Vercel

ระบบเกม Spyfall แบบครบวงจรพร้อมเล่น ใช้ **Yjs + y-webrtc** (public signaling) ไม่ต้องมีแบ็กเอนด์/ฐานข้อมูล

## ฟีเจอร์
- ห้องเกมแบบกำหนดรหัส (ผ่าน URL) ซิงก์เรียลไทม์
- โฮสต์เริ่ม/หยุดรอบ ปรับเวลานับถอยหลังได้
- สุ่มสถานที่ + บทบาท พร้อมมี “สายลับ” 1 คน
- UI โหวต + แชท
- Tailwind + โหมด **Light/Dark** (next-themes)
- Next.js 14 (App Router)

## เริ่มต้นใช้งาน
```bash
npm i
npm run dev
# เปิด http://localhost:3000
```

## ดีพลอยขึ้น Vercel
1. สร้างโปรเจกต์ใหม่ใน Vercel และอิมพอร์ตโค้ดนี้
2. Framework Preset: **Next.js**
3. Deploy แล้วแชร์ลิงก์ใช้งานได้ทันที เช่น `https://your-app.vercel.app/?room=my-friends`

## หมายเหตุ
- ใช้ public signaling servers ของ y-webrtc (ฟรี) เหมาะกับกลุ่มผู้เล่นขนาดเล็ก
- ถ้าต้องการเสถียรกว่าเดิม สามารถตั้ง signaling server เองหรือสลับไป y-websocket ได้
- ต้องมีผู้เล่นอย่างน้อย 3 คนต่อรอบ
