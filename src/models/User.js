import mongoose from "mongoose";

const { Schema, model } = mongoose;

const userSchema = new Schema(
  {
    // Unique Identifier
    uid: { type: String, index: true },

    // User Info
    username: { type: String, index: true },
    fullName: { type: String },

    // Area
    oblId: { type: Number }, // Viloyat
    districtId: { type: Number }, // Tuman/shahar
    areaId: { type: Number }, // Mahalla
    defStreetId: { type: Number }, // Ko'cha
  },
  { timestamps: true },
);

export default model("User", userSchema);
