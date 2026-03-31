# Cortisol AI — Solution Document

## 1. Bối cảnh & Vấn đề

Bộ phận kế toán hiện đang xử lý các quy trình tài chính (phiếu thu chi, báo cáo dòng tiền, theo dõi giờ tự học) hoàn toàn thủ công trên ERP. Điều này dẫn đến:

- **Phê duyệt chậm**: Người duyệt phải vào ERP để kiểm tra và phê duyệt từng phiếu — không có thông báo chủ động.
- **Báo cáo mất thời gian**: Kế toán phải tự xuất file sổ cái, pivot thủ công để tổng hợp dòng tiền theo tháng.
- **Khó theo dõi giờ tự học**: Nhân sự phải tự tính, dễ sai sót; quản lý không biết ai vượt 30h cho đến khi đã muộn.

---

## 2. Giải pháp

**Cortisol AI** là một middleware layer nằm giữa Twendee ERP và Telegram, tự động hoá 3 luồng nghiệp vụ chính:

| # | Tính năng | Trigger | Output |
|---|---|---|---|
| 1 | Phê duyệt phiếu chi | Poll ERP mỗi 30s | Tin nhắn Telegram có nút bấm |
| 2 | Báo cáo tài chính | Upload file Excel qua Telegram | File Excel tổng hợp + Q&A AI |
| 3 | Báo cáo giờ tự học | Cron hàng tuần (thứ 2) | Cảnh báo Telegram cho quản lý |

---

## 3. Tính năng chi tiết

### 3.1 Quy trình phê duyệt phiếu chi

**Vấn đề giải quyết:** Người duyệt không biết khi nào có phiếu cần duyệt; phải vào ERP mới thấy.

**Luồng hoạt động:**

```
ERP tạo phiếu chi (status=PROCESSING)
        ↓
Cortisol AI poll ERP mỗi 30 giây
        ↓
Phát hiện phiếu mới → lấy chi tiết
        ↓
Gửi tin nhắn Telegram cho chị Quỳnh
  [💸 Phiếu chi PC_001 | 15.000.000 VND]
  [✅ Xác nhận]  [❌ Hoàn]
        ↓
Chị Quỳnh bấm "Xác nhận"
        ↓
Cortisol AI gọi ERP: POST /approve
        ↓
Gửi tin nhắn cho chị Linh (người duyệt tiếp theo)
        ↓
Chị Linh → chị Linh xác nhận → gửi cho anh Long
        ↓
Anh Long xác nhận → ERP status = APPROVED
        ↓
Thông báo chị Quỳnh: "Phiếu đã được duyệt hoàn toàn"
```

**Xử lý khi bị Hoàn:**
- Bất kỳ ai bấm "Hoàn" → gọi ERP `POST /reject`
- Thông báo người trước trong chuỗi để cập nhật lại phiếu
- Xóa nút bấm trên tin nhắn cũ (tránh bấm nhầm)

**Điều kiện tiên quyết:**
- Mapping ERP User ID ↔ Telegram Chat ID phải được cấu hình trước

---

### 3.2 Tự động sinh báo cáo tài chính

**Vấn đề giải quyết:** Kế toán mất nhiều giờ tổng hợp sổ cái thành báo cáo dòng tiền; không có cách nhanh để tra cứu một tài khoản cụ thể.

**Dữ liệu đầu vào (gửi qua Telegram):**

| File | Nội dung |
|---|---|
| Danh sách tài khoản | Mã tài khoản (cha/con), tên, loại thu/chi |
| Sổ cái tháng | Ngày, mã TK, diễn giải, số tiền, loại tiền |

**Đầu ra:**

1. **File Excel tổng hợp** — Tổng thu/chi theo tài khoản, theo tháng, có rollup cha-con
2. **Kết quả Q&A** — Trả lời câu hỏi bằng ngôn ngữ tự nhiên (AI)

**Ví dụ Q&A:**
```
User: "Chi phí nhân sự tháng 3 là bao nhiêu?"
Bot:  "Chi phí nhân sự (TK 334) tháng 3/2025: 285.000.000 VND
       Tăng 12% so với tháng 2 (253.500.000 VND)"
```

**Cảnh báo bất thường:** Nếu một khoản phát sinh vượt N lần độ lệch chuẩn so với cùng kỳ, gửi alert vào group kế toán.

---

### 3.3 Báo cáo % tỷ lệ tự học

**Vấn đề giải quyết:** Khó phát hiện nhân sự tự học > 30h/tháng sớm; phát hiện muộn không còn thời gian điều chỉnh.

**Công thức tính:**

```
Giờ chuẩn = Số ngày làm việc trong tuần × 8h
           - Giờ nghỉ phép đã duyệt (có lương + không lương)
           - Giờ nghỉ lễ

Giờ tự học = Giờ chuẩn - Tổng giờ đã log trên Jira

Vi phạm: Giờ tự học > 30h trong tuần (tính từ T2 - T6 tuần trước)
```

**Lịch chạy:** Mỗi thứ 2 sáng → kiểm tra tuần trước → gửi báo cáo cho chị Quỳnh.

**Tin nhắn cảnh báo mẫu:**
```
⚠️ Cảnh báo tự học vượt mức — Tuần 24/03 - 28/03

👤 Nguyễn Văn A:  35.5h  (vượt 5.5h)
👤 Trần Thị B:    32.0h  (vượt 2.0h)

Tổng: 2 nhân sự vi phạm
```

---

## 4. Phạm vi (In/Out of Scope)

### Trong phạm vi (v1)
- [x] Nhận sự kiện phiếu chi PAYMENT từ ERP qua polling
- [x] Gửi/nhận thao tác phê duyệt qua Telegram inline button
- [x] Upload Excel → tạo báo cáo dòng tiền tổng hợp
- [x] Q&A ngôn ngữ tự nhiên trên dữ liệu kế toán
- [x] Cảnh báo giờ tự học hàng tuần

### Ngoài phạm vi (v1)
- [ ] Phiếu thu (RECEIPT) — để v2
- [ ] Tạo phiếu chi từ Telegram
- [ ] Đồng bộ thời gian thực (webhook từ ERP chưa có)
- [ ] Dashboard web
- [ ] Phân quyền nhiều level trong bot

---

## 5. Rủi ro & Giảm thiểu

| Rủi ro | Mức độ | Giảm thiểu |
|---|---|---|
| ERP không có webhook → phải poll | Trung bình | Polling 30s + dedup bằng `voucherId` trong DB local |
| Bấm nhầm Xác nhận/Hoàn | Cao | Xóa nút sau khi bấm; log hành động; ERP có API revert |
| Token ERP hết hạn | Thấp | Auto-refresh với retry logic trong `HttpService` |
| File Excel sai format | Trung bình | Validate header khi parse; gửi thông báo lỗi rõ ràng |
| GPT-4 trả lời sai | Trung bình | Prompt có JSON schema cố định; hiển thị số liệu gốc kèm theo |

---

## 6. Stakeholders

| Người | Vai trò | Tương tác với bot |
|---|---|---|
| Chị Quỳnh | Kế toán — người duyệt đầu tiên | Nhận thông báo phiếu, duyệt/hoàn, nhận báo cáo tự học |
| Chị Linh | Kế toán — người duyệt thứ hai | Nhận thông báo phiếu, duyệt/hoàn |
| Anh Long | Kế toán — người duyệt cuối | Nhận thông báo phiếu, duyệt/hoàn |
| Kế toán viên | Upload file Excel | Upload sổ cái, nhận báo cáo, Q&A |
