# PatchWork

A mobile application for capturing photos with GPS metadata and cryptographic hashing, built with React Native and Expo.

## 📱 Project Overview

PatchWork is a mobile application that allows users to:
- Capture photos using device camera
- Automatically tag photos with GPS coordinates
- Calculate SHA-256 cryptographic hashes of images locally
- Store and manage photo metadata

## 🏗️ Project Structure

```
patchwork/
├── frontend/              # React Native mobile app (Expo SDK 55)
│   ├── src/
│   │   ├── components/   # React components
│   │   │   └── CaptureScreen.tsx
│   │   └── utils/       # Utility functions
│   │       └── imageHash.ts
│   ├── __tests__/        # Jest test files
│   ├── App.tsx          # Main app component
│   ├── package.json     # Dependencies
│   └── app.json         # Expo configuration
├── src/                 # Backend server (Node.js/TypeScript)
├── .env.example         # Environment variables template
├── .gitignore          # Git ignore rules
└── README.md           # This file
```

## 🚀 Getting Started

### Prerequisites

- Node.js (v22 or higher)
- npm or yarn
- Expo Go app on your mobile device (for testing)
- Git

### Frontend Setup (Mobile App)

```bash
cd frontend
npm install
npm start
```

Then scan the QR code with Expo Go app on your mobile device.

### Backend Setup

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Edit .env with your configuration
# DATABASE_URL, AWS credentials, etc.

# Start the server
npm start
```

## 🧪 Testing

### Frontend Tests

```bash
cd frontend
npm test
```

**Test Coverage**: 17 tests, 100% passing
- Image hash utility tests
- Camera component tests
- Permission handling tests

## 📱 Mobile App Features

### Core Functionality

- **Camera Capture**: Take photos using device camera (front/back)
- **GPS Tagging**: Automatic location tagging with each photo
- **SHA-256 Hashing**: Local cryptographic hash calculation
- **Permission Management**: Proper handling of camera and location permissions

### Tech Stack

- **Framework**: React Native with Expo SDK 55
- **Language**: TypeScript 5.9
- **Testing**: Jest 29.7 + React Native Testing Library 12.9
- **Native Modules**:
  - `expo-camera` v55 - Camera access and photo capture
  - `expo-location` v55 - GPS coordinate retrieval
  - `expo-crypto` v55 - SHA-256 hashing
  - `expo-file-system` v55 - File operations

## 🔐 Environment Variables

Copy `.env.example` to `.env` and configure:

```env
# Database Configuration
DATABASE_URL=postgresql://user:password@host:port/database
PORT=3000

# AWS credentials for S3 presigned URL generation
AWS_ACCESS_KEY_ID=your_aws_access_key_id
AWS_SECRET_ACCESS_KEY=your_aws_secret_access_key
AWS_REGION=us-east-2
```

## 📦 Dependencies

### Frontend (mobile)
- `expo` ~55.0.0
- `expo-camera` ~55.0.0
- `expo-location` ~55.1.10
- `expo-crypto` ~55.0.0
- `expo-file-system` ~55.0.0
- `react` 19.2.0
- `react-native` 0.83.6

### Backend
- See `package.json` in root directory

## 🧩 API Documentation

### Image Hashing

```typescript
import { calculateImageHash } from './src/utils/imageHash';

const hash = await calculateImageHash('file:///path/to/image.jpg');
// Returns: SHA-256 hash as hex string
```

### Camera Component

The `CaptureScreen` component handles:
- Camera permission requests
- Location permission requests
- Photo capture with GPS coordinates
- Image hash calculation

## 📱 Device Requirements

- **Android**: Android 5.0+ (API level 21+)
- **iOS**: iOS 13.4+
- **Physical Device Recommended**: Camera and GPS features work best on real devices

## 🔧 Troubleshooting

### Frontend Issues

**Camera not working:**
- Ensure you're testing on a physical device
- Check device permissions for camera and location
- Verify Expo Go app is on SDK 55

**Tests failing:**
- Run `npm install` to ensure dependencies are installed
- Clear cache: `npm start --clear`

### Backend Issues

**Database connection errors:**
- Verify DATABASE_URL in .env
- Check database server is running
- Ensure credentials are correct

**AWS S3 errors:**
- Verify AWS credentials in .env
- Check bucket permissions
- Ensure region is correct

## 🚀 Deployment

### Frontend (Expo)

```bash
cd frontend
# Build for production
npx expo build:android
# or
npx expo build:ios
```

### Backend

See backend-specific documentation in `src/` directory.

## 📝 Development Workflow

1. **Clone the repository**
2. **Install dependencies** (both frontend and backend)
3. **Set up environment variables** from `.env.example`
4. **Run tests** to verify setup
5. **Start development servers**
6. **Make changes and test**
7. **Commit and push**

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass
6. Submit a pull request

## 📄 License

This project is part of the PatchWork application suite.

## 📞 Support

For issues and questions, please refer to the project documentation or contact the development team.

---

**Built with TDD principles** ✅ All tests passing before deployment
