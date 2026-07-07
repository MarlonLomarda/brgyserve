// SMS notification STUB — deliberately no real provider integrated yet.
//
// Every place that should send an SMS (request approved, request rejected,
// and later ready-for-release / claim reminders) calls logSmsNotification()
// so the trigger points are already wired. To integrate a real provider
// (e.g. Semaphore, Twilio), replace the body of this function with the
// provider call and record the result in the notifications table — the
// callers should not need to change.
function logSmsNotification(recipient, message) {
  console.log(`[SMS STUB] to ${recipient || '(no contact number on record)'}: ${message}`);
}

module.exports = { logSmsNotification };
