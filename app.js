(() => {
  "use strict";

  const LOGO = "assets/assajda-logo.png";
  const GRADES = ["Primary 1", "Primary 2", "Primary 3", "Primary 4", "Primary 5", "Primary 6", "JSS 1", "JSS 2", "JSS 3", "SS 1", "SS 2", "SS 3"];
  const SUBJECTS = ["Mathematics", "English", "Physics", "Biology", "Islamic Studies", "ICT"];
  const app = document.getElementById("app");
  let session = null;
  let csrfToken = null;
  let students = [];
  let teachers = [];
  let bulletins = [];
  let messages = [];
  let recommendations = [];
  let currentPage = "dashboard";
  let selectedTeacher = "";
  let selectedStudent = "";
  let syncTimer = null;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  async function api(path, options = {}) {
    const method = options.method || "GET";
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (["POST", "PATCH", "DELETE"].includes(method) && csrfToken && path !== "/api/login" && path !== "/api/setup") {
      headers.set("X-CSRF-Token", csrfToken);
    }
    let response;
    try {
      response = await fetch(path, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: "same-origin",
        cache: "no-store"
      });
    } catch (error) {
      throw new Error("Cannot reach the school server. Start it with `node server.js` and open http://127.0.0.1:4173.");
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || "The request could not be completed.");
    return payload;
  }

  function showToast(message) {
    document.querySelector(".toast")?.remove();
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    toast.textContent = message;
    document.body.append(toast);
    window.setTimeout(() => toast.remove(), 5000);
  }

  function formatDate(value) {
    if (!value) return "—";
    const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
    return Number.isNaN(parsed.getTime()) ? escapeHtml(value) : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: value.includes(":") ? "short" : undefined }).format(parsed);
  }

  function gradeOptions(selected = "") {
    return GRADES.map((grade) => `<option value="${grade}" ${grade === selected ? "selected" : ""}>${grade}</option>`).join("");
  }

  function subjectOptions() {
    return `${SUBJECTS.map((subject) => `<option value="${escapeHtml(subject)}">${escapeHtml(subject)}</option>`).join("")}<option value="__other__">Other (enter subject)</option>`;
  }

  function navItems() {
    if (session.role === "admin") return [
      { id: "dashboard", label: "Dashboard", icon: "▦" },
      { id: "students", label: "Students", icon: "♙" },
      { id: "teachers", label: "Teachers", icon: "♟" }
    ];
    if (session.role === "teacher") return [
      { id: "dashboard", label: "Dashboard", icon: "▦" },
      { id: "class-updates", label: "Notes and exams", icon: "▤" },
      { id: "messages", label: "Student messages", icon: "✉" },
      { id: "recommendations", label: "Admin recommendations", icon: "☆" }
    ];
    return [
      { id: "dashboard", label: "My dashboard", icon: "▦" },
      { id: "messages", label: "Message a teacher", icon: "✉" },
      { id: "profile", label: "My profile", icon: "◉" }
    ];
  }

  function shell(content) {
    const nav = navItems().map((item) => `<button class="nav-item ${currentPage === item.id ? "active" : ""}" type="button" data-page="${item.id}"><span class="nav-icon" aria-hidden="true">${item.icon}</span>${item.label}</button>`).join("");
    app.innerHTML = `
      <header class="topbar">
        <div class="brand"><img src="${LOGO}" alt="Assajda school logo"><div class="brand-name"><strong>Assajda Success Academy Kano</strong><span>Primary and Secondary School</span></div></div>
        <div class="topbar-actions"><span class="sync-pill" id="sync-status" role="status">Connected to school server</span>${session.hasProfileImage ? `<img class="topbar-photo" src="/api/profile-images/${encodeURIComponent(session.id)}" alt="Profile photo">` : ""}<span class="role-pill">${escapeHtml(session.username)}</span><span class="role-pill">${escapeHtml(session.role)}</span>${session.role === "admin" ? `<button class="secondary-btn" id="change-password-btn" type="button">Change password</button>` : ""}<button class="secondary-btn" id="logout-btn" type="button">Sign out</button><button class="icon-btn mobile-menu" id="menu-btn" type="button" aria-label="Toggle navigation" aria-expanded="false">☰</button></div>
      </header>
      <div class="shell">
        <aside class="sidebar" id="sidebar"><p class="side-label">Portal menu</p><nav class="nav-list" aria-label="Main navigation">${nav}</nav><div class="sidebar-note">Keep account passwords private. Messages are visible only to their student and teacher.</div></aside>
        <main class="main" id="main-content">${content}</main>
      </div>
      <div id="modal-root"></div>`;
    document.getElementById("logout-btn").addEventListener("click", logout);
    document.getElementById("change-password-btn")?.addEventListener("click", openChangePassword);
    document.getElementById("menu-btn").addEventListener("click", () => {
      const sidebar = document.getElementById("sidebar");
      sidebar.classList.toggle("open");
      document.getElementById("menu-btn").setAttribute("aria-expanded", String(sidebar.classList.contains("open")));
    });
    document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.page)));
  }

  function pageHeader(eyebrow, title, description, actions = "") {
    return `<header class="page-heading"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${description}</p></div>${actions ? `<div class="heading-actions">${actions}</div>` : ""}</header>`;
  }

  function statCard(icon, label, value) {
    return `<article class="stat-card"><span class="stat-icon" aria-hidden="true">${icon}</span><div><span>${label}</span><strong>${value}</strong></div></article>`;
  }

  function profilePhoto(userId, hasImage, label) {
    return hasImage
      ? `<img class="table-profile-photo" src="/api/profile-images/${encodeURIComponent(userId)}" alt="${escapeHtml(label)} profile">`
      : `<span class="table-profile-placeholder" aria-hidden="true">${escapeHtml(String(label || "?").trim().charAt(0).toUpperCase() || "?")}</span>`;
  }

  function profileUploadButton(userId, hasImage, name) {
    return `<button class="table-action" type="button" data-profile-upload="${escapeHtml(userId)}" data-profile-name="${escapeHtml(name)}">${hasImage ? "Replace photo" : "Upload photo"}</button>`;
  }

  function passwordResetButton(userId, name) {
    return `<button class="table-action" type="button" data-password-reset="${escapeHtml(userId)}" data-profile-name="${escapeHtml(name)}">Reset password</button>`;
  }

  function studentTable(rows, canManage = false) {
    if (!rows.length) return `<tr><td colspan="${canManage ? 7 : 5}"><div class="empty-state"><strong>No students yet</strong>An administrator can add student accounts from this page.</div></td></tr>`;
    return rows.map((student) => `<tr><td>${profilePhoto(student.userId, student.hasProfileImage, student.name)}</td><td><strong>${escapeHtml(student.name)}</strong></td><td>${escapeHtml(student.id)}</td><td>${escapeHtml(student.grade)}</td><td>${escapeHtml(formatDate(student.joined))}</td>${canManage ? `<td>${profileUploadButton(student.userId, student.hasProfileImage, student.name)}</td><td>${passwordResetButton(student.userId, student.name)}</td>` : ""}</tr>`).join("");
  }

  function bulletinCards(category = "", limit = 0) {
    const rows = category ? bulletins.filter((item) => item.category === category) : bulletins;
    if (!rows.length) return `<div class="empty-state"><strong>No updates posted yet</strong>Class notes and exam updates from teachers will appear here.</div>`;
    return (limit ? rows.slice(0, limit) : rows).map((item) => `<article class="panel bulletin-card">
      <div class="panel-head"><div><span class="eyebrow">${escapeHtml(item.category === "exam" ? "Exam update" : "Class note")} · ${escapeHtml(item.grade)}</span><h2>${escapeHtml(item.title)}</h2><p>By ${escapeHtml(item.author || "Teacher")} · ${escapeHtml(formatDate(item.createdAt))}</p></div></div>
      <div class="bulletin-body">${escapeHtml(item.body).replace(/\n/g, "<br>")}</div>
      ${item.hasPdf ? `<p class="bulletin-file"><a href="/api/bulletins/${encodeURIComponent(item.id)}/file" target="_blank" rel="noopener">Download attached PDF</a></p>` : ""}
    </article>`).join("");
  }

  function recommendationCards() {
    if (!recommendations.length) return `<div class="empty-state"><strong>No recommendations yet</strong>Teacher recommendations for the administration will appear here.</div>`;
    return recommendations.map((item) => `<article class="panel bulletin-card"><div class="panel-head"><div><h2>${escapeHtml(item.teacher || `Recommendation #${item.id}`)}</h2><p>${escapeHtml(formatDate(item.createdAt))}</p></div></div><div class="bulletin-body">${escapeHtml(item.body).replace(/\n/g, "<br>")}</div></article>`).join("");
  }

  function bulletinForm() {
    return `<section class="panel compose-panel"><h2>Post class notes or exam updates</h2><p class="muted">Students see updates only for the class you select. Attachments are PDF files up to 2 MB.</p>
      <form id="bulletin-form"><div class="form-grid">
        <div class="field"><label for="bulletin-type">Update type</label><select class="select-input" id="bulletin-type" name="category"><option value="note">Class note</option><option value="exam">Exam update</option></select></div>
        <div class="field"><label for="bulletin-grade">Class</label><select class="select-input" id="bulletin-grade" name="grade">${gradeOptions()}</select></div>
        <div class="field form-full"><label for="bulletin-title">Title</label><input class="field-input" id="bulletin-title" name="title" maxlength="120" required></div>
        <div class="field form-full"><label for="bulletin-body">Notes or exam details</label><textarea class="field-input" id="bulletin-body" name="body" rows="4" maxlength="5000" required></textarea></div>
        <div class="field form-full"><label for="bulletin-pdf">Attach PDF (optional)</label><input class="field-input" id="bulletin-pdf" name="pdf" type="file" accept="application/pdf"><small class="muted">PDF only, maximum 2 MB.</small></div>
      </div><div class="modal-actions"><button class="primary-btn" type="submit">Publish class update</button></div><p id="bulletin-error" class="muted" role="alert"></p></form></section>`;
  }

  function recommendationForm() {
    return `<section class="panel compose-panel"><h2>Send a recommendation to the administrator</h2><form id="recommendation-form"><div class="field"><label for="recommendation-body">Recommendation</label><textarea class="field-input" id="recommendation-body" name="body" rows="4" maxlength="3000" required placeholder="Write your recommendation…"></textarea></div><div class="modal-actions"><button class="primary-btn" type="submit">Send to administrator</button></div></form></section>`;
  }

  function studentMessageForm() {
    const options = teachers.map((teacher) => `<option value="${escapeHtml(teacher.username)}" ${selectedTeacher === teacher.username ? "selected" : ""}>${escapeHtml(teacher.username)}</option>`).join("");
    return `<section class="panel compose-panel"><h2>Message your teacher</h2><p class="muted">Send a private message. You can type or add emojis.</p><form id="message-form">
      <div class="field"><label for="dashboard-message-teacher">Choose a teacher</label><select class="select-input" id="dashboard-message-teacher" name="teacherUsername" ${options ? "" : "disabled"}>${options || `<option value="">No teachers available</option>`}</select></div>
      <div class="field" style="margin-top:14px"><label for="message-body">Your message</label><textarea class="field-input" id="message-body" name="body" maxlength="2000" rows="3" required placeholder="Write a message… Emojis are supported 😊"></textarea></div>
      <div class="chat-actions"><button class="secondary-btn emoji-btn" type="button" data-emoji="😊">😊</button><button class="secondary-btn emoji-btn" type="button" data-emoji="👍">👍</button><button class="primary-btn" type="submit" ${options ? "" : "disabled"}>Send message</button></div><p class="muted">Messages are private and stored on the school server.</p></form></section>`;
  }

  function dashboardPage() {
    if (session.role === "admin") {
      return `${pageHeader("Overview", "Administrator dashboard", `Welcome, ${escapeHtml(session.name)}. Review school records and teacher recommendations.`)}
        <section class="welcome-card"><div><span class="eyebrow" style="color:#c6d8fa">Assajda Success Academy Kano</span><h2>School administration</h2><p>Manage student and teacher accounts, and review recommendations from teachers.</p></div><img class="welcome-logo" src="${LOGO}" alt="Assajda Success Academy logo"></section>
        <section class="stats-grid">${statCard("♙", "Student accounts", students.length)}${statCard("♟", "Teacher accounts", teachers.length)}${statCard("☆", "Recommendations", recommendations.length)}${statCard("▤", "Class updates", bulletins.length)}</section>
        <section><div class="panel-head"><div><h2>Teacher recommendations</h2><p>Visible only to administrators.</p></div></div><div class="card-list">${recommendationCards()}</div></section>`;
    }
    if (session.role === "teacher") {
      return `${pageHeader("Overview", "Teacher dashboard", `Welcome, ${escapeHtml(session.name)}. Post class updates, answer student messages, and share recommendations with the administrator.`)}
        <section class="welcome-card"><div><span class="eyebrow" style="color:#c6d8fa">Teacher workspace</span><h2>Support every learner.</h2><p>Publish notes and exam updates for a class, communicate privately with students, or send a recommendation to the administrator.</p></div><img class="welcome-logo" src="${LOGO}" alt="Assajda Success Academy logo"></section>
        <section class="stats-grid">${statCard("♙", "Student records", students.length)}${statCard("▤", "Class updates", bulletins.length)}${statCard("✉", "Message threads", threadList().length)}${statCard("☆", "Your recommendations", recommendations.length)}</section>
        ${bulletinForm()}
        ${recommendationForm()}
        <section class="panel"><div class="panel-head"><div><h2>Recent class updates</h2><p>Students see updates for their class only.</p></div><button class="text-btn" type="button" data-page="class-updates">Manage updates →</button></div><div class="card-list">${bulletinCards("", 3)}</div></section>`;
    }
    const ownStudent = students.find((student) => student.id === session.studentId);
    const ownBulletins = ownStudent ? bulletins.filter((item) => item.grade === ownStudent.grade) : bulletins;
    return `${pageHeader("Student account", "My dashboard", `Welcome, ${escapeHtml(session.name)}. Read class notes and exam updates, and message your teacher.`)}
      <section class="welcome-card"><div><span class="eyebrow" style="color:#c6d8fa">Your class</span><h2>${escapeHtml(ownStudent?.grade || "Student portal")}</h2><p>Your teacher's notes and exam updates for this class are listed below.</p></div><img class="welcome-logo" src="${LOGO}" alt="Assajda Success Academy logo"></section>
      <section class="stats-grid">${statCard("▤", "Class notes", ownBulletins.filter((item) => item.category === "note").length)}${statCard("✎", "Exam updates", ownBulletins.filter((item) => item.category === "exam").length)}${statCard("✉", "Teachers", teachers.length)}${statCard("◉", "Student ID", escapeHtml(session.studentId || "—"))}</section>
      <section><div class="panel-head"><div><h2>Class notes and exam updates</h2><p>Only updates for your class are shown.</p></div></div><div class="card-list">${bulletinCards()}</div></section>
      ${studentMessageForm()}`;
  }

  function studentsPage() {
    const canManage = session.role === "admin";
    return `${pageHeader("School records", "Student directory", canManage ? "Add students, upload their photos, and reset passwords when needed." : "Read-only access to the shared student directory.", canManage ? `<button class="primary-btn" id="add-student-btn" type="button">＋ Add student</button>` : "")}
      <section class="panel"><div class="table-wrap"><table><thead><tr><th>Photo</th><th>Student name</th><th>Student ID</th><th>Class</th><th>Date added</th>${canManage ? "<th>Profile photo</th><th>Password</th>" : ""}</tr></thead><tbody>${studentTable(students, canManage)}</tbody></table></div></section>`;
  }

  function teachersPage() {
    const rows = teachers.length ? teachers.map((teacher) => `<tr><td>${profilePhoto(teacher.id, teacher.hasProfileImage, teacher.username)}</td><td>${escapeHtml(teacher.username)}</td><td>${escapeHtml(teacher.subject || "Not assigned")}</td><td>${teacher.active ? "Active" : "Inactive"}</td><td>${escapeHtml(formatDate(teacher.createdAt))}</td><td>${profileUploadButton(teacher.id, teacher.hasProfileImage, teacher.username)}</td><td>${passwordResetButton(teacher.id, teacher.username)}</td></tr>`).join("") : `<tr><td colspan="7"><div class="empty-state"><strong>No teacher accounts yet</strong>Create the first teacher account below.</div></td></tr>`;
    const studentOptions = students.length ? students.map((student) => `<option value="${escapeHtml(student.id)}">${escapeHtml(student.name)} (${escapeHtml(student.id)})</option>`).join("") : `<option value="">No student profiles found</option>`;
    return `${pageHeader("Accounts", "Teacher accounts", "Create teacher user IDs, set profile photos, and reset passwords when needed.", `<button class="primary-btn" id="add-teacher-btn" type="button">＋ Add teacher</button>`)}
      <section class="panel compose-panel"><h2>Quick custom account setup</h2><p class="muted">This administrator-only form creates teacher or student accounts with the initial password pass.</p><form id="admin-custom-account-form"><div class="form-grid">
        <div class="field"><label for="custom-role">Account type</label><select class="select-input" id="custom-role" name="role"><option value="teacher">Teacher</option><option value="student">Student</option></select></div>
        <div class="field"><label for="custom-username">User ID</label><input class="field-input" id="custom-username" name="username" minlength="3" maxlength="64" required></div>
        <div class="field"><label for="custom-password">Initial password</label><input class="field-input" id="custom-password" name="password" value="pass" readonly required></div>
        <div class="field" id="custom-subject-group"><label for="custom-subject">Teacher subject</label><select class="select-input" id="custom-subject" name="subject">${subjectOptions()}</select><input class="field-input hidden" id="custom-subject-other" name="subjectOther" maxlength="80" placeholder="Enter subject not listed" aria-label="Custom teacher subject"></div>
        <div class="field" id="custom-student-group"><label for="custom-student">Link to student profile</label><select class="select-input" id="custom-student" name="studentId">${studentOptions}</select></div>
      </div><div class="modal-actions"><button class="primary-btn" type="submit">Create account</button></div><p id="custom-account-error" class="muted" role="alert"></p></form></section>
      <section class="panel"><div class="table-wrap"><table><thead><tr><th>Photo</th><th>Teacher user ID</th><th>Subject</th><th>Status</th><th>Created</th><th>Profile photo</th><th>Password</th></tr></thead><tbody>${rows}</tbody></table></div></section>
      <div class="notice warning" style="margin-top:16px">The initial password for new accounts and password resets is pass. It is weak; replace it with a strong password when possible.</div>`;
  }

  function profilePage() {
    const student = students.find((item) => item.id === session.studentId);
    if (!student) return `${pageHeader("Student account", "Profile unavailable", "Ask a school administrator to check your student account.")}<div class="notice warning">No student record is linked to this account.</div>`;
    return `${pageHeader("Student account", "My profile", "Your personal school record.")}
      <section class="panel"><div class="panel-head">${profilePhoto(student.userId, student.hasProfileImage, student.name)}<div><h2>${escapeHtml(student.name)}</h2><p>${escapeHtml(student.id)}</p></div></div><div class="bulletin-body"><p><strong>Class:</strong> ${escapeHtml(student.grade)}</p><p><strong>Date added:</strong> ${escapeHtml(formatDate(student.joined))}</p></div></section>`;
  }

  function threadList() {
    const other = (message) => message.senderId === session.id ? message.recipientUsername : message.senderUsername;
    const unique = new Map();
    for (const message of messages) {
      const username = other(message);
      unique.set(username, message);
    }
    return [...unique.entries()].map(([username, message]) => ({
      username,
      studentId: session.role === "teacher" ? (message.senderRole === "student" ? message.senderUsername : message.recipientUsername) : "",
      lastAt: message.createdAt
    })).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  function messagesPage() {
    const isStudent = session.role === "student";
    const threads = threadList();
    if (isStudent && !selectedTeacher && teachers.length) selectedTeacher = teachers[0].username;
    if (!isStudent && !selectedStudent && threads.length) selectedStudent = threads[0].studentId;
    const counterpart = isStudent ? selectedTeacher : selectedStudent;
    const thread = messages.filter((message) => {
      const from = message.senderId === session.id;
      return isStudent
        ? ((from && message.recipientUsername === counterpart) || (!from && message.senderUsername === counterpart))
        : ((from && message.recipientUsername === counterpart) || (!from && message.senderUsername === counterpart));
    });
    const options = isStudent
      ? teachers.map((teacher) => `<option value="${escapeHtml(teacher.username)}" ${selectedTeacher === teacher.username ? "selected" : ""}>${escapeHtml(teacher.username)}</option>`).join("")
      : threads.map((item) => `<option value="${escapeHtml(item.studentId)}" ${selectedStudent === item.studentId ? "selected" : ""}>${escapeHtml(item.studentId)}</option>`).join("");
    const selectLabel = isStudent ? "Choose a teacher" : "Student conversation";
    const select = `<div class="field"><label for="message-counterpart">${selectLabel}</label><select class="select-input" id="message-counterpart" ${options ? "" : "disabled"}>${options || `<option value="">${isStudent ? "No teachers available" : "No student messages yet"}</option>`}</select></div>`;
    const conversation = thread.length ? thread.map((message) => `<article class="chat-message ${message.senderId === session.id ? "chat-own" : ""}"><div class="chat-meta">${escapeHtml(message.senderId === session.id ? "You" : (isStudent ? message.senderUsername : message.senderUsername))} · ${escapeHtml(formatDate(message.createdAt))}</div><div>${escapeHtml(message.body).replace(/\n/g, "<br>")}</div></article>`).join("") : `<div class="empty-state"><strong>No messages in this conversation</strong>${isStudent ? "Send your teacher a message below. You can include emojis." : "The student can start the conversation from their dashboard."}</div>`;
    const canSend = Boolean(counterpart) && (isStudent || thread.length > 0);
    return `${pageHeader("Private conversation", isStudent ? "Message a teacher" : "Student messages", isStudent ? "Only you and the selected teacher can see these messages." : "Messages are private to you and each student. Select a student to reply.")}
      <section class="panel chat-panel"><div class="chat-controls">${select}</div><div class="chat-thread" id="chat-thread">${conversation}</div>
      ${canSend ? `<form class="chat-compose" id="message-form"><label class="sr-only" for="message-body">Write a message</label><textarea class="field-input" id="message-body" name="body" maxlength="2000" rows="3" required placeholder="Write a message… Emojis are supported 😊"></textarea><div class="chat-actions"><button class="secondary-btn emoji-btn" type="button" data-emoji="😊">😊</button><button class="secondary-btn emoji-btn" type="button" data-emoji="👍">👍</button><button class="primary-btn" type="submit">Send message</button></div><p class="muted">Messages are private and stored on the school server.</p></form>` : ""}</section>`;
  }

  function recommendationsPage() {
    return `${pageHeader("Teacher workspace", "Recommendations to admin", "Send a private recommendation to the administrator. Only administrators can view it.")}
      ${recommendationForm()}
      <section><div class="panel-head"><div><h2>Your submitted recommendations</h2></div></div><div class="card-list">${recommendationCards()}</div></section>`;
  }

  function updatesPage() {
    const form = session.role === "teacher" ? bulletinForm() : "";
    return `${pageHeader("Classroom", "Notes and exam updates", session.role === "teacher" ? "Write updates for a class or attach an exam-note PDF." : "Review updates teachers have posted for each class.")}${form}<div class="card-list">${bulletinCards()}</div>`;
  }

  function renderMain() {
    if (!session) return renderLogin();
    if (session.mustChangePassword) return renderForcedPasswordChange();
    if (!navItems().some((item) => item.id === currentPage)) currentPage = "dashboard";
    let content;
    if (currentPage === "students" && session.role !== "student") content = studentsPage();
    else if (currentPage === "teachers" && session.role === "admin") content = teachersPage();
    else if (currentPage === "profile" && session.role === "student") content = profilePage();
    else if (currentPage === "messages" && ["student", "teacher"].includes(session.role)) content = messagesPage();
    else if (currentPage === "class-updates" && session.role === "teacher") content = updatesPage();
    else if (currentPage === "recommendations" && session.role === "teacher") content = recommendationsPage();
    else if (session.role === "teacher" && currentPage === "dashboard") content = dashboardPage();
    else if (session.role === "student" && currentPage === "dashboard") content = dashboardPage();
    else content = dashboardPage();
    shell(content);
    document.getElementById("add-student-btn")?.addEventListener("click", openAddStudent);
    document.getElementById("add-teacher-btn")?.addEventListener("click", openAddTeacher);
    document.getElementById("admin-custom-account-form")?.addEventListener("submit", createCustomAccount);
    document.querySelectorAll("[data-profile-upload]").forEach((button) => button.addEventListener("click", () => {
      openProfileImageUpload(button.dataset.profileUpload, button.dataset.profileName);
    }));
    document.querySelectorAll("[data-password-reset]").forEach((button) => button.addEventListener("click", () => {
      openPasswordReset(button.dataset.passwordReset, button.dataset.profileName);
    }));
    const customRole = document.getElementById("custom-role");
    const customStudentGroup = document.getElementById("custom-student-group");
    const customSubjectGroup = document.getElementById("custom-subject-group");
    const customSubject = document.getElementById("custom-subject");
    const customSubjectOther = document.getElementById("custom-subject-other");
    if (customRole && customStudentGroup && customSubjectGroup) {
      const updateCustomRole = () => {
        customStudentGroup.style.display = customRole.value === "student" ? "block" : "none";
        customSubjectGroup.style.display = customRole.value === "teacher" ? "block" : "none";
      };
      customRole.addEventListener("change", updateCustomRole);
      updateCustomRole();
    }
    if (customSubject && customSubjectOther) {
      const updateCustomSubject = () => customSubjectOther.classList.toggle("hidden", customSubject.value !== "__other__");
      customSubject.addEventListener("change", updateCustomSubject);
      updateCustomSubject();
    }
    document.getElementById("message-counterpart")?.addEventListener("change", (event) => {
      if (session.role === "student") selectedTeacher = event.target.value;
      else selectedStudent = event.target.value;
      renderMain();
    });
    document.getElementById("message-form")?.addEventListener("submit", sendMessage);
    document.querySelectorAll("[data-emoji]").forEach((button) => button.addEventListener("click", () => insertEmoji(button.dataset.emoji)));
    document.getElementById("bulletin-form")?.addEventListener("submit", publishBulletin);
    document.getElementById("recommendation-form")?.addEventListener("submit", submitRecommendation);
  }

  function loginScreen(message = "") {
    app.innerHTML = `<main class="login-screen">
      <section class="login-aside"><div class="login-brand"><img src="${LOGO}" alt="Assajda Success Academy logo"><div><strong>Assajda Success Academy Kano</strong><span>Primary and Secondary School</span></div></div><div class="login-pitch"><span class="eyebrow" style="color:#c6d8fa">School portal</span><h1>A confident start for every learner.</h1><p>Secure access to class updates, school records, and messages.</p></div><div class="login-foot">Node.js server · SQLite database · Private school accounts</div></section>
      <section class="login-panel-wrap"><div class="login-panel"><span class="eyebrow">Welcome back</span><h2>Sign in to your portal</h2><p>Use the account details provided by your school administrator.</p>
      ${message ? `<div class="notice warning" role="status">${escapeHtml(message)}</div>` : ""}
      <form class="login-form" id="login-form"><div class="field"><label for="login-role">Account type</label><select class="select-input" id="login-role" name="role"><option value="student">Student</option><option value="teacher">Teacher</option><option value="admin">Administrator</option></select></div>
      <div class="field"><label for="login-username">Student ID or user ID</label><input class="field-input" id="login-username" name="username" autocomplete="username" required placeholder="Enter your student ID or user ID"></div>
      <div class="field"><label for="login-password">Password</label><input class="field-input" id="login-password" name="password" type="password" autocomplete="current-password" required placeholder="Enter your password"></div>
      <button class="primary-btn" type="submit">Sign in</button><p class="muted" id="login-error" role="alert"></p></form>
      </div></section></main>`;
    document.getElementById("login-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      document.getElementById("login-error").textContent = "";
      try {
        const data = new FormData(form);
        const result = await api("/api/login", { method: "POST", body: { role: data.get("role"), username: data.get("username"), password: data.get("password") } });
        session = result.user;
        csrfToken = result.csrfToken;
        currentPage = "dashboard";
        await startSession();
      } catch (error) {
        document.getElementById("login-error").textContent = error.message;
        button.disabled = false;
      }
    });
  }

  function setupScreen(setupKeyRequired = false) {
    app.innerHTML = `<main class="login-screen"><section class="login-aside"><div class="login-brand"><img src="${LOGO}" alt="Assajda Success Academy logo"><div><strong>Assajda Success Academy Kano</strong><span>Primary and Secondary School</span></div></div><div class="login-pitch"><span class="eyebrow" style="color:#c6d8fa">Secure setup</span><h1>Create the administrator account.</h1><p>This one-time setup is available only while no administrator account exists.</p></div><div class="login-foot">No default usernames or passwords are installed.</div></section>
      <section class="login-panel-wrap"><div class="login-panel"><span class="eyebrow">First-time setup</span><h2>Set up administrator</h2><p class="notice warning">The initial password is pass. This is weak; change it to a strong password after setup.</p><form class="login-form" id="setup-form">
      <div class="field"><label for="setup-username">Administrator user ID</label><input class="field-input" id="setup-username" name="username" autocomplete="username" minlength="3" maxlength="64" pattern="[A-Za-z0-9._-]+" required></div>
      ${setupKeyRequired ? `<div class="field"><label for="setup-key">Administrator setup key</label><input class="field-input" id="setup-key" name="setupKey" type="password" autocomplete="off" minlength="32" required></div>` : ""}
      <input type="hidden" id="setup-password" name="password" value="pass"><input type="hidden" id="setup-confirm" name="confirm" value="pass">
      <button class="primary-btn" type="submit">Create administrator</button><p id="setup-error" class="muted" role="alert"></p></form></div></section></main>`;
    document.getElementById("setup-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      if (data.get("password") !== data.get("confirm")) {
        document.getElementById("setup-error").textContent = "The passwords do not match.";
        return;
      }
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        await api("/api/setup", { method: "POST", body: { username: data.get("username"), password: data.get("password"), setupKey: data.get("setupKey") } });
        loginScreen("Administrator created. Sign in with the user ID and password you just chose.");
      } catch (error) {
        document.getElementById("setup-error").textContent = error.message;
        button.disabled = false;
      }
    });
  }

  async function loadData() {
    const requests = [api("/api/students"), api("/api/bulletins")];
    if (session.role === "admin" || session.role === "student") requests.push(api("/api/teachers"));
    if (session.role === "teacher" || session.role === "student") requests.push(api("/api/messages"));
    if (session.role === "admin" || session.role === "teacher") requests.push(api("/api/recommendations"));
    const results = await Promise.all(requests);
    let index = 0;
    students = results[index++].students;
    bulletins = results[index++].bulletins;
    if (session.role === "admin" || session.role === "student") teachers = results[index++].teachers;
    if (session.role === "teacher" || session.role === "student") messages = results[index++].messages;
    if (session.role === "admin" || session.role === "teacher") recommendations = results[index++].recommendations;
    if (session.role === "student" && !selectedTeacher && teachers.length) selectedTeacher = teachers[0].username;
    if (session.role === "teacher" && !selectedStudent) selectedStudent = threadList()[0]?.studentId || "";
  }

  async function startSession() {
    if (session.mustChangePassword) {
      renderMain();
      return;
    }
    await loadData();
    renderMain();
    startSync();
  }

  function startSync() {
    stopSync();
    syncTimer = window.setInterval(async () => {
      if (!session || document.hidden || session.mustChangePassword) return;
      try {
        await loadData();
        const status = document.getElementById("sync-status");
        if (status) status.textContent = `Synced ${new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date())}`;
        if (!document.getElementById("modal-root")?.firstElementChild) renderMain();
      } catch (error) {
        const status = document.getElementById("sync-status");
        if (status) status.textContent = "Sync unavailable";
        console.error("Could not sync school portal data.", error);
      }
    }, 10000);
  }

  function stopSync() {
    if (syncTimer) window.clearInterval(syncTimer);
    syncTimer = null;
  }

  async function logout() {
    try {
      await api("/api/logout", { method: "POST" });
    } catch (error) {
      console.error("Server sign-out failed.", error);
      showToast(error.message);
    }
    stopSync();
    session = null;
    csrfToken = null;
    loginScreen();
  }

  function navigate(page) {
    if (!navItems().some((item) => item.id === page)) return;
    currentPage = page;
    renderMain();
  }

  function modal(content) {
    const root = document.getElementById("modal-root");
    root.innerHTML = `<div class="modal-backdrop" id="modal-backdrop"><section class="modal" role="dialog" aria-modal="true">${content}</section></div>`;
    document.getElementById("modal-backdrop").addEventListener("click", (event) => {
      if (event.target.id === "modal-backdrop") closeModal();
    });
  }

  function closeModal() {
    const root = document.getElementById("modal-root");
    if (root) root.innerHTML = "";
  }

  function showCredentials(title, username, password, role) {
    modal(`<div class="modal-head"><h2>${escapeHtml(title)}</h2><button class="icon-btn" id="close-credentials" type="button" aria-label="Close dialog">×</button></div>
      <div class="modal-body"><div class="notice warning">Copy these sign-in details and give them privately to the ${escapeHtml(role)}. The password cannot be viewed again.</div>
      <div class="credential-card"><div><span>User ID</span><strong>${escapeHtml(username)}</strong></div><div><span>Initial password</span><strong>${escapeHtml(password)}</strong></div></div>
      <div class="modal-actions"><button class="primary-btn" id="finish-credentials" type="button">I have saved these details</button></div></div>`);
    document.getElementById("close-credentials").addEventListener("click", closeModal);
    document.getElementById("finish-credentials").addEventListener("click", closeModal);
  }

  function openProfileImageUpload(userId, name) {
    modal(`<div class="modal-head"><h2>Profile photo for ${escapeHtml(name)}</h2><button class="icon-btn" id="close-profile-image" type="button" aria-label="Close dialog">×</button></div>
      <form class="modal-body" id="profile-image-form"><div class="field"><label for="profile-image-file">Choose an image</label><input class="field-input" id="profile-image-file" name="image" type="file" accept="image/jpeg,image/png,image/webp" required></div>
      <p class="muted">JPG, PNG, or WebP; maximum 1 MB.</p><p id="profile-image-error" class="muted" role="alert"></p>
      <div class="modal-actions"><button class="secondary-btn" id="cancel-profile-image" type="button">Cancel</button><button class="primary-btn" type="submit">Upload photo</button></div></form>`);
    document.getElementById("close-profile-image").addEventListener("click", closeModal);
    document.getElementById("cancel-profile-image").addEventListener("click", closeModal);
    document.getElementById("profile-image-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const file = form.elements.image.files[0];
      const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
      if (!file || !allowedTypes.includes(file.type) || file.size > 1024 * 1024) {
        document.getElementById("profile-image-error").textContent = "Choose a JPG, PNG, or WebP image no larger than 1 MB.";
        return;
      }
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        const image = await readDataUrl(file, "Could not read the selected image.");
        await api(`/api/profile-images/${encodeURIComponent(userId)}`, { method: "POST", body: { image } });
        closeModal();
        await loadData();
        renderMain();
        showToast("Profile photo uploaded.");
      } catch (error) {
        document.getElementById("profile-image-error").textContent = error.message;
        button.disabled = false;
      }
    });
  }

  function openPasswordReset(userId, name) {
    modal(`<div class="modal-head"><h2>Reset password for ${escapeHtml(name)}</h2><button class="icon-btn" id="close-reset-password" type="button" aria-label="Close dialog">×</button></div>
      <div class="modal-body"><p class="notice warning">The current password will stop working immediately. A new password will be shown once; copy it and share it privately.</p>
      <div class="modal-actions"><button class="secondary-btn" id="cancel-reset-password" type="button">Cancel</button><button class="primary-btn" id="confirm-reset-password" type="button">Reset password</button></div></div>`);
    document.getElementById("close-reset-password").addEventListener("click", closeModal);
    document.getElementById("cancel-reset-password").addEventListener("click", closeModal);
    document.getElementById("confirm-reset-password").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const result = await api(`/api/admin-accounts/${encodeURIComponent(userId)}/reset-password`, { method: "POST", body: {} });
        closeModal();
        showCredentials(`${result.role === "student" ? "Student" : "Teacher"} password reset`, result.username, result.password, result.role);
      } catch (error) {
        showToast(error.message);
        button.disabled = false;
      }
    });
  }

  async function createCustomAccount(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const role = String(data.get("role") || "teacher");
    const username = String(data.get("username") || "").trim();
    const password = String(data.get("password") || "");
    const studentId = role === "student" ? String(data.get("studentId") || "") : "";
    const selectedSubject = String(data.get("subject") || "");
    const subject = role === "teacher"
      ? selectedSubject === "__other__" ? String(data.get("subjectOther") || "").trim() : selectedSubject
      : "";
    const errorNode = document.getElementById("custom-account-error");
    if (!username || password !== "pass") {
      errorNode.textContent = "Choose a user ID. New accounts use the initial password pass.";
      return;
    }
    if (role === "student" && !studentId) {
      errorNode.textContent = "Select the linked student profile before creating the student account.";
      return;
    }
    try {
      const result = await api("/api/admin-accounts", { method: "POST", body: { role, username, password, studentId, subject } });
      form.reset();
      errorNode.textContent = "";
      await loadData();
      renderMain();
      showCredentials(`${role === "student" ? "Student" : "Teacher"} account created`, result.username, result.password, role);
    } catch (error) {
      errorNode.textContent = error.message;
    }
  }

  function openAddTeacher() {
    modal(`<div class="modal-head"><h2>Add teacher account</h2><button class="icon-btn" id="close-teacher" type="button" aria-label="Close dialog">×</button></div>
      <form class="modal-body" id="teacher-form"><div class="field"><label for="teacher-username">Teacher user ID</label><input class="field-input" id="teacher-username" name="username" minlength="3" maxlength="64" pattern="[A-Za-z0-9._-]+" autocomplete="off" required></div>
      <div class="field"><label for="teacher-subject">Subject</label><select class="select-input" id="teacher-subject" name="subject">${subjectOptions()}</select><input class="field-input hidden" id="teacher-subject-other" name="subjectOther" maxlength="80" placeholder="Enter subject not listed" aria-label="Custom teacher subject"></div>
      <p class="notice warning">Initial password: <strong>pass</strong>. The administrator can reset it later.</p><p id="teacher-error" class="muted" role="alert"></p>
      <div class="modal-actions"><button class="secondary-btn" type="button" id="cancel-teacher">Cancel</button><button class="primary-btn" type="submit">Create teacher</button></div></form>`);
    document.getElementById("close-teacher").addEventListener("click", closeModal);
    document.getElementById("cancel-teacher").addEventListener("click", closeModal);
    const subjectSelect = document.getElementById("teacher-subject");
    const otherSubjectInput = document.getElementById("teacher-subject-other");
    const updateSubjectOther = () => otherSubjectInput.classList.toggle("hidden", subjectSelect.value !== "__other__");
    subjectSelect.addEventListener("change", updateSubjectOther);
    updateSubjectOther();
    document.getElementById("teacher-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        const username = String(new FormData(form).get("username")).trim();
        const password = "pass";
        const selectedSubject = subjectSelect.value;
        const subject = selectedSubject === "__other__" ? otherSubjectInput.value.trim() : selectedSubject;
        await api("/api/teachers", { method: "POST", body: { username, password, subject } });
        closeModal();
        await loadData();
        renderMain();
        showCredentials("Teacher account created", username, password, "teacher");
      } catch (error) {
        document.getElementById("teacher-error").textContent = error.message;
        button.disabled = false;
      }
    });
  }

  function openAddStudent() {
    modal(`<div class="modal-head"><h2>Add student account</h2><button class="icon-btn" id="close-student" type="button" aria-label="Close dialog">×</button></div>
      <form class="modal-body" id="student-form"><div class="field"><label for="student-name">Student full name</label><input class="field-input" id="student-name" name="name" maxlength="80" required></div>
      <div class="field"><label for="student-grade">Class</label><select class="select-input" id="student-grade" name="grade">${gradeOptions()}</select></div>
      <p class="notice warning">The initial password will be <strong>pass</strong>. The administrator can reset it later.</p><p id="student-error" class="muted" role="alert"></p>
      <div class="modal-actions"><button class="secondary-btn" type="button" id="cancel-student">Cancel</button><button class="primary-btn" type="submit">Create student</button></div></form>`);
    document.getElementById("close-student").addEventListener("click", closeModal);
    document.getElementById("cancel-student").addEventListener("click", closeModal);
    document.getElementById("student-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        const result = await api("/api/students", { method: "POST", body: { name: data.get("name"), grade: data.get("grade") } });
        closeModal();
        await loadData();
        renderMain();
        showCredentials("Student account created", result.student.id, result.temporaryPassword, "student");
      } catch (error) {
        document.getElementById("student-error").textContent = error.message;
        button.disabled = false;
      }
    });
  }

  function readFile(file) {
    return readDataUrl(file, "Could not read the selected PDF.");
  }

  function readDataUrl(file, errorMessage) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error(errorMessage));
      reader.readAsDataURL(file);
    });
  }

  async function publishBulletin(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const file = form.elements.pdf.files[0];
    if (file && (file.type !== "application/pdf" || file.size > 2 * 1024 * 1024)) {
      document.getElementById("bulletin-error").textContent = "Choose a PDF no larger than 2 MB.";
      return;
    }
    button.disabled = true;
    document.getElementById("bulletin-error").textContent = "";
    try {
      const data = new FormData(form);
      const pdf = file ? await readFile(file) : null;
      await api("/api/bulletins", { method: "POST", body: { category: data.get("category"), grade: data.get("grade"), title: data.get("title"), body: data.get("body"), pdf } });
      await loadData();
      renderMain();
      showToast("Class update published.");
    } catch (error) {
      document.getElementById("bulletin-error").textContent = error.message;
      button.disabled = false;
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = form.elements.body.value.trim();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const recipient = session.role === "student"
        ? { teacherUsername: form.elements.teacherUsername?.value || selectedTeacher }
        : { studentId: selectedStudent };
      await api("/api/messages", { method: "POST", body: { ...recipient, body } });
      await loadData();
      renderMain();
      showToast("Message sent.");
    } catch (error) {
      showToast(error.message);
      button.disabled = false;
    }
  }

  function insertEmoji(emoji) {
    const input = document.getElementById("message-body");
    if (!input) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    input.setRangeText(emoji, start, end, "end");
    input.focus();
  }

  async function submitRecommendation(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await api("/api/recommendations", { method: "POST", body: { body: form.elements.body.value } });
      await loadData();
      renderMain();
      showToast("Recommendation sent to the administrator.");
    } catch (error) {
      showToast(error.message);
      button.disabled = false;
    }
  }

  function openChangePassword() {
    modal(`<div class="modal-head"><h2>${session.mustChangePassword ? "Set a new password" : "Change password"}</h2>${session.mustChangePassword ? "" : `<button class="icon-btn" id="close-password" type="button" aria-label="Close dialog">×</button>`}</div>
      <form class="modal-body" id="password-form"><div class="notice">Use at least 12 characters. Passwords are stored as salted hashes and cannot be viewed by staff.</div>
      <div class="field"><label for="current-password">Current password</label><input class="field-input" id="current-password" name="currentPassword" type="password" autocomplete="current-password" required></div>
      <div class="field"><label for="new-password">New password</label><input class="field-input" id="new-password" name="newPassword" type="password" minlength="12" maxlength="256" autocomplete="new-password" required></div>
      <div class="field"><label for="confirm-password">Confirm new password</label><input class="field-input" id="confirm-password" name="confirmPassword" type="password" minlength="12" maxlength="256" autocomplete="new-password" required></div>
      <p id="password-error" class="muted" role="alert"></p><div class="modal-actions">${session.mustChangePassword ? "" : `<button class="secondary-btn" id="cancel-password" type="button">Cancel</button>`}<button class="primary-btn" type="submit">Update password</button></div></form>`);
    document.getElementById("close-password")?.addEventListener("click", closeModal);
    document.getElementById("cancel-password")?.addEventListener("click", closeModal);
    document.getElementById("password-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      if (data.get("newPassword") !== data.get("confirmPassword")) {
        document.getElementById("password-error").textContent = "The new passwords do not match.";
        return;
      }
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        const result = await api("/api/password", { method: "POST", body: { currentPassword: data.get("currentPassword"), newPassword: data.get("newPassword") } });
        session = result.user;
        csrfToken = result.csrfToken;
        closeModal();
        await loadData();
        currentPage = "dashboard";
        renderMain();
        startSync();
        showToast("Password updated successfully.");
      } catch (error) {
        document.getElementById("password-error").textContent = error.message;
        button.disabled = false;
      }
    });
    document.getElementById("current-password").focus();
  }

  function renderForcedPasswordChange() {
    app.innerHTML = `<main class="login-screen"><section class="login-aside"><div class="login-brand"><img src="${LOGO}" alt="Assajda Success Academy logo"><div><strong>Assajda Success Academy Kano</strong><span>Primary and Secondary School</span></div></div><div class="login-pitch"><span class="eyebrow" style="color:#c6d8fa">Account security</span><h1>One quick security step.</h1><p>Set a private password before continuing to your portal.</p></div><div class="login-foot">Your password is never visible to school staff.</div></section><section class="login-panel-wrap"><div class="login-panel"><span class="eyebrow">Temporary password</span><h2>Change your password</h2><p>Your school issued an initial password. Replace it with a personal password to continue.</p><div id="modal-root"></div></div></section></main>`;
    openChangePassword();
  }

  async function initialize() {
    try {
      const setup = await api("/api/setup");
      if (setup.setupRequired) {
        setupScreen(setup.setupKeyRequired);
        return;
      }
      const result = await api("/api/session");
      session = result.user;
      csrfToken = result.csrfToken;
      if (!session) {
        loginScreen();
        return;
      }
      currentPage = session.role === "student" ? "dashboard" : "dashboard";
      await startSession();
    } catch (error) {
      loginScreen(error.message);
    }
  }

  initialize();
})();
