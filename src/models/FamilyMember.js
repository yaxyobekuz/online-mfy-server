import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * Xonadon (uy) tarkibidagi oila a'zosi.
 * Tashqi API: /web/v1/tables/survey_homes_family/data
 */
const familyMemberSchema = new Schema(
  {
    // Tashqi tizimdagi asosiy identifikator
    memberId: { type: String, required: true },

    // Qaysi xonadonga tegishli
    homeId: { type: String, required: true, index: true },

    // F.I.Sh.
    fullName: { type: String },

    // Xonadon egasiga nisbatan qarindoshlik darajasi (masalan "хонадон эгаси")
    relationship: { type: String },

    // Tug'ilgan sana
    birthDate: { type: String },

    // JSHSHIR
    pinfl: { type: String },

    // Telefon raqami
    phone: { type: String },

    // User
    userUid: { type: String, required: true, index: true },
  },
  { timestamps: true },
);

export default model("FamilyMember", familyMemberSchema);
