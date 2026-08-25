import { BsPeopleFill } from "react-icons/bs";
import { IoMdListBox } from "react-icons/io";
import { BsHousesFill } from "react-icons/bs";
import { IoDocumentsSharp } from "react-icons/io5";
import { MdPayments } from "react-icons/md";
import { MdEditDocument } from "react-icons/md";
import { FaBoxes } from "react-icons/fa";
import { FaCalendarAlt } from "react-icons/fa";
import { FaAddressBook } from "react-icons/fa";
import { FaPeopleCarry } from "react-icons/fa";
import { MdNotificationsActive } from "react-icons/md";
import { IoMdAnalytics } from "react-icons/io";

// Dashboard nav tabs per role, shared by every page of that role's area.
export const SECRETARY_NAV = [
  { to: "/secretary", label: "Resident review", icon: BsPeopleFill, end: true },
  { to: "/secretary/residents", label: "Resident records", icon: IoMdListBox },
  { to: "/secretary/households", label: "Households", icon: BsHousesFill },
  {
    to: "/secretary/requests",
    label: "Document requests",
    icon: IoDocumentsSharp,
  },
  { to: "/secretary/payments", label: "Payments", icon: MdPayments },
  {
    to: "/secretary/document-types",
    label: "Document types",
    icon: MdEditDocument,
  },
  { to: "/secretary/rental-items", label: "Rental items", icon: FaBoxes },
  { to: "/secretary/rentals", label: "Rental bookings", icon: FaCalendarAlt },
  { to: "/secretary/blotter", label: "Blotter", icon: FaAddressBook },
  { to: "/secretary/events", label: "Events", icon: FaPeopleCarry },
  {
    to: "/secretary/notifications",
    label: "Notifications",
    icon: MdNotificationsActive,
  },
  { to: "/secretary/reports", label: "Reports", icon: IoMdAnalytics },
];

export const RESIDENT_NAV = [
  { to: "/resident", label: "My requests", end: true, icon: IoDocumentsSharp },
  { to: "/resident/request", label: "Request a document", icon: MdEditDocument },
  { to: "/resident/rentals", label: "My rentals", icon: FaBoxes },
  {
    to: "/resident/book-rental",
    label: "Book a facility",
    icon: FaCalendarAlt,
  },
  { to: "/resident/events", label: "Events", icon: FaPeopleCarry },
  { to: "/resident/household", label: "My household", icon: BsHousesFill },
];

export const TREASURER_NAV = [
  { to: "/treasurer", label: "Payments", end: true, icon: MdPayments },
  { to: "/treasurer/reports", label: "Reports", icon: IoMdAnalytics },
];

export const STAFF_NAV = [
  { to: "/staff", label: "Rental bookings", end: true, icon: FaCalendarAlt },
  { to: "/staff/households", label: "Households", icon: BsHousesFill },
  { to: "/staff/residents", label: "Resident records", icon: IoMdListBox },
  { to: "/staff/requests", label: "Document requests", icon: IoDocumentsSharp },
  { to: "/staff/events", label: "Events", icon: FaPeopleCarry },
];

export const PUNONG_BARANGAY_NAV = [
  { to: "/punong-barangay", label: "Rental bookings", end: true, icon: FaCalendarAlt },
  { to: "/punong-barangay/blotter", label: "Blotter", icon: FaAddressBook },
  {
    to: "/punong-barangay/residents",
    label: "Resident records",
    icon: IoMdListBox,
  },
  {
    to: "/punong-barangay/requests",
    label: "Document requests",
    icon: IoDocumentsSharp,
  },
  { to: "/punong-barangay/events", label: "Events", icon: FaPeopleCarry },
  { to: "/punong-barangay/reports", label: "Reports", icon: IoMdAnalytics },
];
