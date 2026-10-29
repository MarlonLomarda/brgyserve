const readableDate = (dateString) => {
  const date = new Date(dateString);
  
  return date.toLocaleString("en-PH", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Manila",
  });
};

module.exports = { readableDate };
